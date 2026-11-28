import type { Agent } from "./agent.js";

/** Picks a legal action uniformly at random (finds rule holes and endless loops). */
export const randomAgent: Agent = {
  name: "random",
  choose: (_view, legal, rng) => rng.pick(legal),
};
