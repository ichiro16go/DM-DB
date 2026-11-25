import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { CardMeta } from "../types";

const Ctx = createContext<CardMeta | null>(null);

/** Card DB facets (keywords, sets, tags …), loaded once for the whole app. */
export function CardMetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<CardMeta | null>(null);
  useEffect(() => {
    api.meta().then(setMeta, (e) => console.error(e));
  }, []);
  return <Ctx.Provider value={meta}>{children}</Ctx.Provider>;
}

export const useCardMeta = () => useContext(Ctx);
