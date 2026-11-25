import { NavLink, Route, Routes } from "react-router-dom";
import { CardMetaProvider, useCardMeta } from "./lib/cardMeta";
import { SearchPage } from "./pages/SearchPage";
import { MetaPage } from "./pages/MetaPage";
import { ArchetypePage } from "./pages/ArchetypePage";
import { DecksPage } from "./pages/DecksPage";
import { DeckEditorPage } from "./pages/DeckEditorPage";
import { QualityPage } from "./pages/QualityPage";
import { HelpPage } from "./pages/HelpPage";

function Stats() {
  const meta = useCardMeta();
  if (!meta) return null;
  return (
    <span className="muted">
      {meta.counts.cards.toLocaleString()} 種 / {meta.counts.printings.toLocaleString()} 収録 / {meta.counts.sets} 商品
    </span>
  );
}

export function App() {
  return (
    <CardMetaProvider>
      <header className="top">
        <div className="brand">
          DM Card DB <Stats />
        </div>
        <nav className="tabs">
          <NavLink to="/" end>
            検索
          </NavLink>
          <NavLink to="/meta">環境</NavLink>
          <NavLink to="/decks">デッキ</NavLink>
          <NavLink to="/quality">データ品質</NavLink>
          <NavLink to="/help">クエリ構文</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/meta" element={<MetaPage />} />
          <Route path="/meta/archetype" element={<ArchetypePage />} />
          <Route path="/decks" element={<DecksPage />} />
          <Route path="/decks/new" element={<DeckEditorPage />} />
          <Route path="/decks/:id" element={<DeckEditorPage />} />
          <Route path="/quality" element={<QualityPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="*" element={<p className="muted">ページが見つかりません。</p>} />
        </Routes>
      </main>
    </CardMetaProvider>
  );
}
