import { useState } from 'react';
import { Check, MessageCircle, X } from 'lucide-react';
import type { BoardEditor } from './editor';
import { newShapeId, type CommentShape } from './model';
import { useBoard } from './useBoard';
import { PANEL } from './BoardChrome';

export function Comments({ editor, author }: { editor: BoardEditor; author: string }): JSX.Element | null {
  const selection = useBoard(editor, (e) => e.selection);
  const shapes = useBoard(editor, (e) => e.shapes);
  const selected = selection.size === 1 ? shapes.get([...selection][0]) : null;
  return selected?.type === 'comment' ? <Thread key={selected.id} shape={selected} editor={editor} author={author} /> : null;
}

function Thread({ shape, editor, author }: { shape: CommentShape; editor: BoardEditor; author: string }): JSX.Element {
  const [draft, setDraft] = useState('');
  return (
    <section role="dialog" aria-label="Comment thread" className={`${PANEL} w-[min(300px,calc(100vw-92px))] p-3 text-sm`}>
      <div className="mb-3 flex items-center gap-2 font-semibold text-foreground">
        <MessageCircle className="size-4" /> Comments
        <button type="button" aria-label="Close comments" className="ml-auto p-1" onClick={() => editor.setSelection([])}><X className="size-4" /></button>
      </div>
      <div data-board-scroll className="max-h-56 space-y-3 overflow-y-auto select-text">
        {shape.thread.length === 0 && <p className="text-xs">Start a conversation here.</p>}
        {shape.thread.map((m) => <div key={m.id}><div className="text-xs font-semibold text-foreground">{m.author} <time className="ml-1 font-normal text-muted-foreground">{new Date(m.at).toLocaleString()}</time></div><p className="whitespace-pre-wrap break-words">{m.text}</p></div>)}
      </div>
      <form className="mt-3 space-y-2" onSubmit={(e) => {
        e.preventDefault();
        if (!draft.trim()) return;
        // Read the latest record so a remote reply received while typing survives.
        const current = editor.shapes.get(shape.id);
        if (current?.type !== 'comment') return;
        editor.updateShape(shape.id, { thread: [...current.thread, { id: newShapeId(), author, text: draft.trim(), at: Date.now() }] });
        setDraft('');
      }}>
        <textarea autoFocus aria-label="Reply" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={5000} rows={3} className="w-full resize-none rounded-lg border border-border bg-transparent p-2 text-foreground outline-none focus:border-brand" />
        <div className="flex items-center justify-between gap-2">
          <button type="button" className="flex items-center gap-1 text-xs" onClick={() => editor.updateShape(shape.id, { resolved: !shape.resolved })}><Check className="size-3" />{shape.resolved ? 'Reopen' : 'Resolve'}</button>
          <button type="submit" disabled={!draft.trim()} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-40">Reply</button>
        </div>
      </form>
    </section>
  );
}
