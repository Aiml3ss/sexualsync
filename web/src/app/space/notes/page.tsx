"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { createKink } from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { loadPrivateNotes, savePrivateNotes, type PrivateNote } from "@/lib/private-notes";

export default function NotesPage() {
  const [notes, setNotes] = useState<PrivateNote[]>([]);
  const [draft, setDraft] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [busyId, setBusyId] = useState("");
  const [status, setStatus] = useState("");
  const loadingNotesRef = useRef<PrivateNote[] | null>(null);

  useEffect(() => {
    // Hydration-safe localStorage read for the notes list, plus an async
    // profile fetch to pick up the active workspace. loadPrivateNotes() is
    // async (it decrypts at rest) and returns [] while the app lock is engaged
    // — notes stay hidden until unlock, which is the intended privacy behavior.
    loadPrivateNotes().then((loaded) => {
      loadingNotesRef.current = loaded;
      setNotes(loaded);
    });
    getProfileCached()
      .then((profile) => setWorkspaceId(profile.activeWorkspace?.id || ""))
      .catch(() => setWorkspaceId(""));
  }, []);

  useEffect(() => {
    if (loadingNotesRef.current) {
      if (notes !== loadingNotesRef.current) return;
      loadingNotesRef.current = null;
    }
    void savePrivateNotes(notes);
  }, [notes]);

  function addNote() {
    const text = draft.trim();
    if (!text) return;
    setNotes([{ id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }, ...notes]);
    setDraft("");
  }

  async function shareNote(note: PrivateNote) {
    if (!workspaceId || busyId) return;
    setBusyId(note.id);
    setStatus("");
    try {
      await createKink({ workspaceId, text: note.text });
      setStatus("Shared kink.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't share this note.");
    } finally {
      setBusyId("");
    }
  }

  function deleteNote(id: string) {
    setNotes((current) => current.filter((note) => note.id !== id));
  }

  function updateNoteText(id: string, text: string) {
    setNotes((current) => current.map((note) => note.id === id ? { ...note, text } : note));
  }

  return (
    <AppShell>
      <ScreenHeader
        eyebrow={<Link href="/space" className="text-ink-3">‹ Space</Link>}
        showBrand={false}
        title="Private notes"
        subtitle="Keep it just for you."
      />

      <div className="space-y-4 px-5 pb-10">
        <section className="rounded-card border border-dashed border-line bg-surface/60 p-4">
          <textarea
            className="input min-h-[112px] resize-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write the thing you want to remember."
            aria-label="Private note"
            autoCapitalize="none"
            autoCorrect="on"
            spellCheck
            inputMode="text"
          />
          <button type="button" className="btn-primary mt-3 w-full" disabled={!draft.trim()} onClick={addNote}>
            Save note
          </button>
        </section>

        {status && <p className="text-sm text-ink-2">{status}</p>}

        <section className="space-y-2">
          {notes.map((note) => (
            <PrivateNoteCard
              key={note.id}
              note={note}
              workspaceId={workspaceId}
              busyId={busyId}
              onChange={updateNoteText}
              onDelete={deleteNote}
              onShare={shareNote}
            />
          ))}
        </section>

        <p className="text-center text-xs text-ink-3">Stored on this device. Never synced.</p>
      </div>
    </AppShell>
  );
}

function PrivateNoteCard({
  note,
  workspaceId,
  busyId,
  onChange,
  onDelete,
  onShare,
}: {
  note: PrivateNote;
  workspaceId: string;
  busyId: string;
  onChange: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onShare: (note: PrivateNote) => void;
}) {
  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const input = noteInputRef.current;
    if (!input) return;
    // Defer the scrollHeight read/write off the keystroke's critical path so
    // the forced reflow doesn't land on every character — same pattern as the
    // Sext composer (chat/page.tsx).
    const raf = requestAnimationFrame(() => {
      input.style.height = "0px";
      input.style.height = `${input.scrollHeight}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [note.text]);

  return (
    <article className="card p-4">
      <textarea
        ref={noteInputRef}
        className="min-h-11 w-full resize-none overflow-hidden bg-transparent font-display text-[19px] italic leading-relaxed text-ink outline-none"
        value={note.text}
        onChange={(event) => onChange(note.id, event.target.value)}
        rows={1}
        aria-label="Edit private note"
        autoCapitalize="none"
        autoCorrect="on"
        spellCheck
        inputMode="text"
      />
      <p className="mt-3 font-mono text-[10px] uppercase text-ink-3">
        private · {new Date(note.createdAt).toLocaleDateString()}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Link
          href={`/ask?note=${encodeURIComponent(note.text)}`}
          className="btn-ghost min-w-0 px-2 text-center text-xs leading-tight"
        >
          Turn into Ask
        </Link>
        <button
          type="button"
          className="btn-ghost min-w-0 px-2 text-center text-xs leading-tight"
          disabled={!workspaceId || busyId === note.id}
          onClick={() => onShare(note)}
        >
          {busyId === note.id ? "Sharing..." : "Share Kink"}
        </button>
        <button
          type="button"
          className="btn-ghost min-w-0 px-2 text-center text-xs leading-tight"
          onClick={() => onDelete(note.id)}
        >
          Delete
        </button>
      </div>
    </article>
  );
}
