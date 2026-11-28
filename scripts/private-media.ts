/**
 * Media under public/ that templates use but that is NOT in git, on purpose (#50).
 *
 * The rule: media a template needs to render is committed, as long as it is
 * small and ours (we made it, or it has a licence that lets us publish it).
 * The repo is public, so everything else stays on the computer that has it
 * and is listed here, with where it comes from. The guard test
 * (scripts/template-media.test.ts) fails when a template uses a file under
 * public/ that is neither tracked in git nor on this list, and when a file on
 * this list is tracked after all.
 *
 * Only add an entry for media that can't be public: footage, interview cuts,
 * artist photos, and music we don't own (third-party songs only ever live
 * here, never in a template's tracked folder). Anything else: commit it.
 *
 * `path` is relative to public/. Ending in "/" means the whole folder.
 */
export type PrivateMedia = {
  path: string;
  /** Why it can't be in the public repo. */
  why: string;
  /** Where it comes from: the command that makes it, or who has it. */
  from: string;
  /** The render writes it itself (a reel's cut), so a share (#60) doesn't carry it. */
  generated?: boolean;
};

export const PRIVATE_MEDIA: PrivateMedia[] = [
  {
    path: "audio/private/",
    why: "copyrighted music: the weekly lineup beds, and any song you are only testing with",
    from: "`bun scripts/pick-track.ts` copies a track from the music library folder (ask Dean) into it",
  },
  {
    path: "audio/fuse-drums/",
    why: "Denzo's old local copy of the Fuse-Drums clip (#49); the committed clip lives under ident/audio/fusedrums/",
    from: "only Denzo's computer has it; nothing uses it any more, so it can be deleted",
  },
  {
    path: "session/",
    why: "footage: the first and last 5 seconds of an edited interview (SessionOpen / SessionClose)",
    from: "cut from a finished sesh-edit episode with ffmpeg; AGENTS.md \"Session logo reveal\" has the two commands",
  },
  {
    path: "reel/",
    why: "footage: the cut interview a reel plays (SessionReel)",
    from: "`bun run reel <name>.reel.json` writes it from a sesh-edit clean cut (longform/README.md, \"A reel from an episode\")",
    generated: true,
  },
  {
    path: "fort-riddim/",
    why: "Manuel's phone footage, the event's soundtrack and the FORT RIDDIM poster artwork",
    from: "`bun scripts/fort-riddim/make.ts` from Manuel's clips; logo and poster cut-outs copied in by hand from the poster (README \"Media for local compositions\")",
  },
  {
    path: "artists/",
    why: "artists' photos: theirs, not ours to publish",
    from: "`bun run poster --photo <path-or-url>` copies the photo in; the portal CDN has every artist's photo",
  },
];

/** Is `path` (relative to public/) on the private list? */
export function isPrivate(path: string, list: PrivateMedia[] = PRIVATE_MEDIA): PrivateMedia | undefined {
  return list.find((m) => (m.path.endsWith("/") ? path.startsWith(m.path) : path === m.path));
}
