import { act, renderHook, waitFor } from "@testing-library/react";
import { Direction } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeClient, makeRoom, mkMatrixEvent, pushTimelineEvent } from "../../test/factories";
import { MatrixClientPeg } from "../client/peg";
import { useFillGap } from "./use-fill-gap";
import { useTimeline } from "./use-timeline";

const me = "@me:h.example";
const roomId = "!r:h.example";

afterEach(() => MatrixClientPeg.reset());

function gappyRoom() {
  const client = makeFakeClient({ userId: me });
  const room = makeRoom(roomId, { client, myUserId: me, timelineSupport: true });
  const push = (eventId: string, body: string) =>
    pushTimelineEvent(
      room,
      mkMatrixEvent({
        eventId,
        roomId,
        sender: "@a:h.example",
        type: "m.room.message",
        content: { msgtype: "m.text", body },
      }),
    );
  push("$old1", "one");
  room.resetLiveTimeline("prev_batch_tok", "old_sync_tok");
  push("$new1", "three");

  const paginate = vi.fn().mockResolvedValue(true);
  Object.assign(client as unknown as Record<string, unknown>, {
    getRoom: () => room,
    paginateEventTimeline: paginate,
  });
  MatrixClientPeg.injectClientForTest(client);
  return { room, paginate };
}

describe("useFillGap", () => {
  it("paginates the timeline that starts at the gap, not the live one", async () => {
    const { room, paginate } = gappyRoom();
    const [older, newer] = room.getUnfilteredTimelineSet().getTimelines();

    const { result } = renderHook(() => useFillGap(roomId, 50));
    await act(async () => {
      await result.current.fillGap("$new1");
    });

    expect(paginate).toHaveBeenCalledWith(newer, { backwards: true, limit: 50 });
    expect(paginate).not.toHaveBeenCalledWith(older, expect.anything());
  });

  it("exposes which gap is loading and clears it afterwards", async () => {
    const { paginate } = gappyRoom();
    let release: (v: boolean) => void = () => {};
    paginate.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );

    const { result } = renderHook(() => useFillGap(roomId));
    expect(result.current.pendingGapId).toBeNull();

    let pending: Promise<void>;
    await act(async () => {
      pending = result.current.fillGap("$new1");
    });
    expect(result.current.pendingGapId).toBe("$new1");

    await act(async () => {
      release(true);
      await pending;
    });
    expect(result.current.pendingGapId).toBeNull();
  });

  it("ignores a second click while one fill is in flight", async () => {
    const { paginate } = gappyRoom();
    let release: (v: boolean) => void = () => {};
    paginate.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );

    const { result } = renderHook(() => useFillGap(roomId));
    await act(async () => {
      void result.current.fillGap("$new1");
    });
    await act(async () => {
      void result.current.fillGap("$new1");
      release(true);
    });

    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it("is inert for an event that belongs to no timeline", async () => {
    const { paginate } = gappyRoom();

    const { result } = renderHook(() => useFillGap(roomId));
    await act(async () => {
      await result.current.fillGap("$nowhere");
    });

    expect(paginate).not.toHaveBeenCalled();
    expect(result.current.pendingGapId).toBeNull();
  });

  it("clears the pending id when pagination rejects", async () => {
    const { paginate } = gappyRoom();
    paginate.mockRejectedValue(new Error("network"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useFillGap(roomId));
    await act(async () => {
      await result.current.fillGap("$new1");
    });

    expect(result.current.pendingGapId).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves the live timeline's own back-pagination alone", async () => {
    const { room, paginate } = gappyRoom();
    room.getLiveTimeline().setPaginationToken("tok", Direction.Backward);

    const { result } = renderHook(() => useFillGap(roomId));
    await act(async () => {
      await result.current.fillGap("$old1");
    });

    const [older] = room.getUnfilteredTimelineSet().getTimelines();
    expect(paginate).toHaveBeenCalledWith(older, { backwards: true, limit: 50 });
  });
});

describe("useFillGap across joined timelines", () => {
  // In a thread the anchor can sit one or more joined timelines below the
  // hole. Its own timeline's backward token was nulled by the join, and
  // paginateEventTimeline reads a null token as "from the latest event", which
  // walks away from the hole.
  it("paginates the head of the anchor's timeline chain, not the anchor's own timeline", async () => {
    const client = makeFakeClient({ userId: me });
    const room = makeRoom(roomId, { client, myUserId: me, timelineSupport: true });
    const push = (eventId: string) =>
      pushTimelineEvent(
        room,
        mkMatrixEvent({
          eventId,
          roomId,
          sender: "@a:h.example",
          type: "m.room.message",
          content: { msgtype: "m.text", body: eventId },
        }),
      );
    push("$a1");
    room.resetLiveTimeline("hole_tok", "old_sync_tok");
    push("$b1");
    room.resetLiveTimeline("joined_tok", "mid_sync_tok");
    push("$c1");
    const [, middle, newest] = room.getUnfilteredTimelineSet().getTimelines();
    newest.setNeighbouringTimeline(middle, Direction.Backward);
    middle.setNeighbouringTimeline(newest, Direction.Forward);

    const paginate = vi.fn().mockResolvedValue(true);
    Object.assign(client as unknown as Record<string, unknown>, {
      getRoom: () => room,
      paginateEventTimeline: paginate,
    });
    MatrixClientPeg.injectClientForTest(client);

    const { result } = renderHook(() => useFillGap(roomId));
    await act(async () => {
      await result.current.fillGap("$c1");
    });

    expect(paginate).toHaveBeenCalledWith(middle, { backwards: true, limit: 50 });
    expect(paginate).not.toHaveBeenCalledWith(newest, expect.anything());
  });
});

describe("useFillGap for an anchor in no timeline", () => {
  // A thread root fetched on its own belongs to no timeline, so the marker
  // anchored to it has to fill the hole above it, and retire once joined.
  it("paginates the hole above a fetched-root anchor, and the marker retires on join", async () => {
    const client = makeFakeClient({ userId: me });
    const room = makeRoom(roomId, { client, myUserId: me, timelineSupport: true });
    const msg = (eventId: string, ts: number, extra: Record<string, unknown> = {}) =>
      pushTimelineEvent(
        room,
        mkMatrixEvent({
          eventId,
          roomId,
          sender: "@a:h.example",
          type: "m.room.message",
          content: { msgtype: "m.text", body: eventId, ...extra },
          ts,
        }),
      );
    msg("$f-old", 1000);
    room.resetLiveTimeline("hole_tok", "old_sync_tok");
    msg("$f-new-r1", 3000, { "m.relates_to": { rel_type: "m.thread", event_id: "$f-root" } });

    const paginate = vi.fn().mockImplementation(async (newer) => {
      const [older] = room.getUnfilteredTimelineSet().getTimelines();
      newer.setNeighbouringTimeline(older, Direction.Backward);
      older.setNeighbouringTimeline(newer, Direction.Forward);
      newer.setPaginationToken(null, Direction.Backward);
      return true;
    });
    Object.assign(client as unknown as Record<string, unknown>, {
      getRoom: () => room,
      paginateEventTimeline: paginate,
      fetchRoomEvent: vi.fn().mockResolvedValue({
        event_id: "$f-root",
        room_id: roomId,
        sender: "@a:h.example",
        type: "m.room.message",
        content: { msgtype: "m.text", body: "$f-root" },
        origin_server_ts: 2000,
      }),
    });
    MatrixClientPeg.injectClientForTest(client);

    const timeline = renderHook(() => useTimeline(roomId));
    await waitFor(() => expect(timeline.result.current.gapBeforeEventIds).toEqual(["$f-root"]));
    const [, newer] = room.getUnfilteredTimelineSet().getTimelines();
    expect(room.getUnfilteredTimelineSet().getTimelineForEvent("$f-root")).toBeNull();

    const { result } = renderHook(() => useFillGap(roomId));
    await act(async () => {
      await result.current.fillGap("$f-root");
    });

    expect(paginate).toHaveBeenCalledWith(newer, { backwards: true, limit: 50 });
    const after = renderHook(() => useTimeline(roomId));
    expect(after.result.current.gapBeforeEventIds).toEqual([]);
  });
});
