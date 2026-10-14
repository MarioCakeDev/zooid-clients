import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmptyTurnIndicator, EMPTY_TURN_TOOLTIP } from "./empty-turn-indicator";

afterEach(cleanup);

function renderIt(props: { agentName: string; stopReason?: string }) {
  return render(
    <TooltipProvider>
      <EmptyTurnIndicator {...props} />
    </TooltipProvider>,
  );
}

describe("<EmptyTurnIndicator />", () => {
  it("states the fact", () => {
    renderIt({ agentName: "architect" });
    expect(screen.getByText("architect ended its turn without output")).toBeInTheDocument();
  });

  it("carries the ambiguity in the tooltip", async () => {
    renderIt({ agentName: "architect" });
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(EMPTY_TURN_TOOLTIP);
    expect(EMPTY_TURN_TOOLTIP).toBe(
      "No content was produced. This may be deliberate, or may indicate an error swallowed upstream — by the ACP adapter, the harness, or the model provider.",
    );
  });

  it("shows the stop reason in the tooltip", async () => {
    renderIt({ agentName: "architect", stopReason: "end_turn" });
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Stop reason: end_turn");
  });

  it("has no stop reason line without one", async () => {
    renderIt({ agentName: "architect" });
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).not.toHaveTextContent("Stop reason:");
  });

  it("is not styled as an error", () => {
    const { container } = renderIt({ agentName: "architect" });
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.innerHTML).not.toMatch(/destructive|red-|amber-|yellow-/);
  });

  it("is keyboard reachable", async () => {
    renderIt({ agentName: "architect" });
    await userEvent.tab();
    expect(screen.getByText("architect ended its turn without output")).toHaveFocus();
  });
});
