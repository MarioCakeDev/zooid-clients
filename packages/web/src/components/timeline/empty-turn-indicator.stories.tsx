import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmptyTurnIndicator } from "./empty-turn-indicator";

const meta = {
  title: "Timeline/EmptyTurnIndicator",
  component: EmptyTurnIndicator,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="max-w-xl">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
  args: { agentName: "architect", stopReason: "end_turn" },
} satisfies Meta<typeof EmptyTurnIndicator>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NoStopReason: Story = { args: { stopReason: undefined } };
export const LongAgentName: Story = { args: { agentName: "the-extremely-long-agent-display-name-x" } };
export const TooltipOpen: Story = {
  parameters: { layout: "centered" },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole("button");
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
  },
};
