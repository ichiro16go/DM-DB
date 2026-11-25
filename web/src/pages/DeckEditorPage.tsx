import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, type DeckWrite } from "../api";
import { CardModal } from "../components/Card";
import { DeckList } from "../components/DeckList";
import { DeckSearchPanel } from "../components/DeckSearchPanel";
import { DeckStats } from "../components/DeckStats";
import { Revisions } from "../components/Revisions";
import { addCard, deckToText, fmtDate, FORMAT_LABEL, normalize, STATUS_LABEL } from "../lib/deck";
import { useBeforeUnload, useDebounced } from "../lib/hooks";
import type { Deck, DeckAnalysis, DeckCard, DeckKind, DeckSource, DeckStatus, Format, Zone } from "../types";

/** Router state for /decks/new (from the meta page's "＋登録" or "コピーして新規"). */
export interface NewDeckState {
  kind?: DeckKind;
  format?: Format;
  archetype?: string | null;
  name?: string;
  source?: DeckSource | null;
  images?: string[];
  cards?: DeckCard[];
  note?: string;
}

interface Form {
  name: string;
  format: Format;
  archetype: string;
  status: DeckStatus;
  note: string;
  cards: DeckCard[];
}

const toForm = (d: Pick<Deck, "name" | "format" | "archetype" | "status" | "note" | "cards">): Form => ({
  name: d.name,
  format: d.format,
  archetype: d.archetype ?? "",
  status: d.status,
  note: d.note,
  cards: d.cards,
});
const same = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b);

export function DeckEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const init = (location.state ?? {}) as NewDeckState;

  const [deck, setDeck] = useState<Deck | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [form, setForm] = useState<Form>(() => ({
    name: init.name ?? "新しいデッキ",
    format: init.format ?? (params.get("format") === "advance" ? "advance" : "original"),
    archetype: init.archetype ?? "",
    status: init.kind === "meta" ? "partial" : "complete",
    note: init.note ?? "",
    cards: init.cards ?? [],
  }));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<DeckAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "conflict"; text: string } | null>(null);
  const [modal, setModal] = useState<number | null>(null);
  const [panel, setPanel] = useState<"search" | "photo" | "import" | "export">(init.images?.length ? "photo" : "search");
  const [importText, setImportText] = useState("");

  const isNew = !id;
  const kind: DeckKind = deck?.kind ?? init.kind ?? "user";
  const source = deck?.source ?? init.source ?? null;
  const images = useMemo(() => [...new Set([...(init.images ?? []), ...(source?.image ? [source.image] : [])])], [init.images, source?.image]);
  const dirty = isNew ? form.cards.length > 0 : saved !== null && !same(form, saved);
  useBeforeUnload(dirty);

  const applyLoaded = useCallback((r: { deck: Deck; version: string; analysis?: DeckAnalysis }) => {
    setDeck(r.deck);
    setVersion(r.version);
    const f = toForm(r.deck);
    setSaved(f);
    setForm(f);
    if (r.analysis) setAnalysis(r.analysis);
  }, []);

  const load = useCallback(() => {
    if (!id) return;
    setLoadError(null);
    api.deck(id).then(applyLoaded, (e: Error) => setLoadError(e.message));
  }, [id, applyLoaded]);
  useEffect(load, [load]);

  // Live analysis (name resolution + construction rules) while editing.
  const dCards = useDebounced(form.cards, 350);
  const lastAnalyzed = useRef<string>("");
  useEffect(() => {
    const k = JSON.stringify([form.format, dCards]);
    if (k === lastAnalyzed.current) return;
    lastAnalyzed.current = k;
    let live = true;
    setAnalyzing(true);
    api.analyze(form.format, dCards).then(
      (a) => live && (setAnalysis(a), setAnalyzing(false)),
      () => live && setAnalyzing(false),
    );
    return () => {
      live = false;
    };
  }, [dCards, form.format]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const setCards = (cards: DeckCard[]) => set({ cards });
  const add = (zone: Zone, name: string, n = 1) => setForm((f) => ({ ...f, cards: addCard(f.cards, zone, name, n) }));

  const body = (): DeckWrite => ({
    name: form.name.trim() || "無題のデッキ",
    format: form.format,
    archetype: form.archetype.trim() || null,
    status: form.status,
    note: form.note,
    cards: form.cards,
  });

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) setMessage({ kind: "conflict", text: e.message });
    else setMessage({ kind: "error", text: (e as Error).message });
  };

  const save = async (overwrite = false) => {
    setBusy(true);
    setMessage(null);
    try {
      if (isNew) {
        const r = await api.createDeck({ ...body(), kind, source });
        applyLoaded(r);
        navigate(`/decks/${r.deck.id}`, { replace: true });
      } else {
        // overwrite: re-read the latest version and save this form over it (the other edit stays in history)
        const v = overwrite ? (await api.deck(id!)).version : version!;
        applyLoaded(await api.updateDeck(id!, v, body()));
      }
      setMessage({ kind: "ok", text: "保存しました" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!busy) void save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const restore = async (index: number) => {
    setBusy(true);
    try {
      applyLoaded(await api.restoreDeck(id!, version!, index));
      setMessage({ kind: "ok", text: "以前の版に戻しました" });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`「${form.name}」を削除しますか？（元に戻せません）`)) return;
    try {
      await api.deleteDeck(id!, version!);
      navigate("/decks", { replace: true });
    } catch (e) {
      fail(e);
    }
  };

  const copy = () => {
    const state: NewDeckState = {
      kind: "user",
      format: form.format,
      archetype: form.archetype || null,
      name: `${form.name}のコピー`.slice(0, 80),
      cards: form.cards,
    };
    navigate("/decks/new", { state });
  };

  const doImport = async (mode: "replace" | "append") => {
    try {
      const { cards } = await api.parse(importText);
      setCards(mode === "replace" ? cards : normalize([...form.cards, ...cards]));
      setImportText("");
      setPanel("search");
    } catch (e) {
      fail(e);
    }
  };

  if (loadError) return <div className="error">{loadError}</div>;
  if (!isNew && !deck) return <p className="muted">読み込み中…</p>;

  return (
    <section className="deck-editor">
      <div className="page-head">
        <Link to={kind === "meta" && form.archetype ? `/meta?format=${form.format}` : "/decks"}>← {kind === "meta" ? "環境デッキ" : "デッキ一覧"}</Link>
        <span className={`kind-badge ${kind}`}>{kind === "meta" ? "環境デッキ（入賞リスト）" : "マイデッキ"}</span>
        {deck && (
          <span className="muted small">
            最終更新 {fmtDate(deck.updatedAt)} {deck.updatedBy && `by ${deck.updatedBy}`}
          </span>
        )}
        <span className="spacer" />
        {dirty && <span className="unsaved">未保存の変更</span>}
        {!isNew && dirty && (
          <button type="button" onClick={() => saved && setForm(saved)} disabled={busy}>
            変更を破棄
          </button>
        )}
        <button type="button" className="primary" onClick={() => save()} disabled={busy || (!isNew && !dirty)} title="Ctrl+S">
          {isNew ? "作成" : "保存"}
        </button>
      </div>

      {message && (
        <div className={message.kind === "ok" ? "notice ok" : "error"}>
          {message.text}
          {message.kind === "conflict" && (
            <span className="conflict-actions">
              <button type="button" onClick={() => (setMessage(null), load())}>
                最新を読み込む（自分の変更は破棄）
              </button>
              <button type="button" onClick={() => save(true)}>
                自分の内容で上書き保存
              </button>
            </span>
          )}
        </div>
      )}

      <div className="deck-meta">
        <label className="grow">
          デッキ名
          <input value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          フォーマット
          <select value={form.format} onChange={(e) => set({ format: e.target.value as Format })}>
            <option value="original">{FORMAT_LABEL.original}</option>
            <option value="advance">{FORMAT_LABEL.advance}</option>
          </select>
        </label>
        <label>
          デッキタイプ
          <input value={form.archetype} maxLength={80} placeholder="例: 赤零ジョーカーズ" onChange={(e) => set({ archetype: e.target.value })} />
        </label>
        <label>
          リストの状態
          <select value={form.status} onChange={(e) => set({ status: e.target.value as DeckStatus })}>
            {(Object.keys(STATUS_LABEL) as DeckStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {source && (
        <div className="panel source small">
          入賞: <b>{source.rank}</b> {source.player && `${source.player}さん`} ／{" "}
          <a href={source.url} target="_blank" rel="noopener">
            {source.eventName ?? "CS結果記事"}
          </a>{" "}
          {source.date} ／ 表記「{source.archetype}」
          {images.length > 0 && (
            <button type="button" className="link" onClick={() => setPanel("photo")}>
              デッキ画像を見ながら編集
            </button>
          )}
        </div>
      )}

      <div className={`editor-grid ${panel === "photo" ? "wide-side" : ""}`}>
        <div className="side">
          <div className="seg">
            <button type="button" className={panel === "search" ? "active" : ""} onClick={() => setPanel("search")}>
              カード検索
            </button>
            {images.length > 0 && (
              <button type="button" className={panel === "photo" ? "active" : ""} onClick={() => setPanel("photo")}>
                デッキ画像
              </button>
            )}
            <button type="button" className={panel === "import" ? "active" : ""} onClick={() => setPanel("import")}>
              テキスト取込
            </button>
            <button type="button" className={panel === "export" ? "active" : ""} onClick={() => setPanel("export")}>
              書き出し
            </button>
          </div>
          {panel === "search" && <DeckSearchPanel format={form.format} cards={form.cards} onAdd={(z, n) => add(z, n)} onOpen={setModal} />}
          {panel === "photo" && (
            <div className="photos">
              <p className="muted small">主催者のデッキ画像（クリックで原寸）。左の画像とリストを見比べて修正してください。</p>
              {images.map((src) => (
                <a key={src} href={src} target="_blank" rel="noopener noreferrer">
                  <img src={src} alt="デッキ画像" referrerPolicy="no-referrer" />
                </a>
              ))}
            </div>
          )}
          {panel === "import" && (
            <div className="import">
              <p className="muted small">
                1行に「枚数 カード名」。<code>超次元</code> / <code>GR</code> の行以降はそのゾーン。
              </p>
              <textarea
                rows={16}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                spellCheck={false}
                placeholder={"4 カード名\n4 カード名\n\n超次元\n1 カード名"}
              />
              <div className="row">
                <button type="button" className="primary" disabled={!importText.trim()} onClick={() => doImport("replace")}>
                  置き換え
                </button>
                <button type="button" disabled={!importText.trim()} onClick={() => doImport("append")}>
                  追加
                </button>
              </div>
            </div>
          )}
          {panel === "export" && (
            <div className="import">
              <textarea rows={16} readOnly value={deckToText(form.cards)} onFocus={(e) => e.target.select()} />
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(deckToText(form.cards)).then(() => setMessage({ kind: "ok", text: "コピーしました" }))}
              >
                クリップボードにコピー
              </button>
            </div>
          )}
        </div>

        <div className="main-col">
          <DeckStats analysis={analysis} format={form.format} pending={analyzing} />
          <DeckList cards={form.cards} analysis={analysis} onChange={setCards} onOpen={setModal} />
          <label className="f note">
            メモ
            <textarea
              rows={3}
              value={form.note}
              maxLength={2000}
              onChange={(e) => set({ note: e.target.value })}
              placeholder="採用理由・不明カードの補足など"
            />
          </label>
          {deck && (
            <>
              <div className="section-title">編集履歴（{deck.revisions.length}）</div>
              <Revisions deck={deck} onRestore={restore} busy={busy || dirty} />
              {dirty && deck.revisions.length > 0 && <p className="muted small">未保存の変更があるときは履歴から戻せません。</p>}
              <div className="danger-zone">
                <button type="button" onClick={copy}>
                  コピーしてマイデッキを作る
                </button>
                <button type="button" className="danger" onClick={remove}>
                  このデッキを削除
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {modal !== null && (
        <CardModal
          id={modal}
          onClose={() => setModal(null)}
          onAdd={(c) => {
            add(c.zone, c.name);
            setMessage({ kind: "ok", text: `${c.name} を追加しました` });
          }}
        />
      )}
    </section>
  );
}
