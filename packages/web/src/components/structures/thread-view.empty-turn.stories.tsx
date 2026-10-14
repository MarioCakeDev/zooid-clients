import type { Meta, StoryObj } from "@storybook/react-vite";
import { makeFakeClient, makeRoom, mkMatrixEvent, pushTimelineEvent } from "../../../test/factories";
import { MatrixClientPeg } from "../../client/peg";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThreadView } from "./thread-view";

const me = "@me:h.example";
const agent = "@architect.acme:h.example";
const roomId = "!empty-turn:h.example";
const root = "$empty-turn-root";
const thread = { "m.relates_to": { rel_type: "m.thread", event_id: root } };
function seed() {
  const client = makeFakeClient({ userId: me });
  const room = makeRoom(roomId, { client, myUserId: me });
  (client as unknown as { getRoom: (id: string) => unknown }).getRoom = (id) => id === roomId ? room : null;
  // Stories must stay offline even when TimelinePanel asks for pagination.
  (client as unknown as { paginateEventTimeline: unknown }).paginateEventTimeline = async () => false;
  const add = (id: string, type: string, sender: string, content: Record<string, unknown>) => pushTimelineEvent(room, mkMatrixEvent({ roomId, eventId: id, sender, type, content }));
  add(root, "m.room.message", me, { msgtype: "m.text", body: "@architect can you look at the deploy config?" });
  add("$empty-end", "dev.zooid.turn.end", agent, { body: "architect finished without output", agent_id: "architect", session_id: "s1", turn_id: "t1", stop_reason: "end_turn", produced_output: false, ...thread });
  add("$empty-reply", "m.room.message", me, { msgtype: "m.text", body: "Hello? Try again please.", ...thread });
  add("$empty-answer", "m.room.message", agent, { msgtype: "m.notice", body: "The deploy config looks fine. Nothing needs changing.", ...thread });
  add("$full-end", "dev.zooid.turn.end", agent, { body: "architect finished", agent_id: "architect", session_id: "s1", turn_id: "t2", stop_reason: "end_turn", produced_output: true, ...thread });
  MatrixClientPeg.injectClientForTest(client);
}
const meta = {
  title: "Structures/ThreadViewEmptyTurn",
  component: ThreadView,
  parameters: { layout: "fullscreen" },
  args: { roomId, rootEventId: root, onBack: () => {} },
} satisfies Meta<typeof ThreadView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SilentThenAnswered: Story = {
  render: (args) => { seed(); return <TooltipProvider><ThreadView {...args} /></TooltipProvider>; },
};
