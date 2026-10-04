// the shapes the readers return. type-only and free of node:*, so the renderer can import them
// (`@grove/record/types`) under a typecheck with no node types.
//
// status, holder, open / answered, superseded and "last activity" are derived by the readers.
// no record stores them.

export type ConclusionKind = "decision" | "finding" | "verdict";
export type CardStatus = "todo" | "in_progress" | "done" | "canceled";
export type ClaimEventKind = "claim" | "release" | "takeover" | "done" | "cancel";
export type By = "agent" | "person";

export interface Project {
  v: number;
  name: string;
  prefix: string;
  goal: string;
  /** goes up by one every time grove changes the file. part of the state revision. */
  rev: number;
  problems: string[];
}

export interface Author {
  /** whose it is. for a conclusion or an answer this can be "person" while an agent wrote the file. */
  by: By;
  /** the session that wrote the file, or "person" when grove wrote it. */
  session: string;
  /** that session's display name. empty when grove wrote it. */
  agent: string;
  /** the subagent's own short name, when one wrote it. */
  sub?: string;
  toolUseId?: string;
  at: string;
}

export interface ClaimEvent extends Author {
  card: string;
  seq: number;
  /** an unknown word is kept as it is and changes nothing. */
  event: ClaimEventKind | string;
  pid: number | null;
  pidStart: string;
  host: string;
  via: string;
  prev: number;
  prevSession: string;
  note: string;
  /** done: the summary. cancel: the reason. release: the note. */
  body: string;
  artifacts: Artifact[];
  file: string;
  problems: string[];
}

export interface Artifact {
  type: "file" | "branch" | "pr" | "link";
  ref: string;
}

/** where a conclusion came from: something the agent was shown or read. */
export interface Source {
  /** an http(s) url, or a path from the project root. */
  ref: string;
  /** one line on what in it mattered. */
  note?: string;
}

export interface Comment extends Author {
  card: string;
  seq: number;
  kind: "comment" | "question" | "answer";
  /** question only: "person" or a card id. */
  to?: string;
  /** answer only: the number of the question it answers. */
  answers?: number;
  text: string;
  artifacts: Artifact[];
  file: string;
  problems: string[];
}

export interface Question extends Comment {
  kind: "question";
  to: string;
  /** derived: no answer comment names it. */
  open: boolean;
  /** derived: the numbers of the comments that answer it. */
  answeredBy: number[];
}

export interface Holder {
  session: string;
  agent: string;
  pid: number | null;
  pidStart: string;
  host: string;
  /** when this session first took the card in its current run of holding it. */
  since: string;
}

export interface Card extends Author {
  id: string;
  title: string;
  body: string;
  from?: string;
  needs: string[];
  file: string;
  problems: string[];
  // derived
  status: CardStatus;
  holder: Holder | null;
  claims: ClaimEvent[];
  comments: Comment[];
  questions: Question[];
  /** an open question on this card is addressed to the person. */
  asksPerson: boolean;
  /** the latest `at` over the card, its comments and its claim events. */
  lastActivity: string;
}

export interface Conclusion extends Author {
  id: string;
  kind: ConclusionKind;
  what: string;
  why: string;
  card?: string;
  replaces?: string;
  related: string[];
  changesPlan: boolean;
  area?: string;
  /** what it was based on. empty for a conclusion written before sources existed. */
  sources: Source[];
  /** the last thing the person typed in the session before it was recorded, cut to 600 characters. */
  said?: string;
  file: string;
  problems: string[];
  // derived
  /** the conclusions that name this one in `replaces`, oldest first. */
  replacedBy: string[];
  superseded: boolean;
}

export interface IndexLine {
  id: string;
  kind: ConclusionKind;
  at: string;
  card?: string;
  by: By;
  replaces?: string;
  what: string;
  replacedBy: string[];
  superseded: boolean;
}

export interface RecordSnapshot {
  root: string;
  project: Project | null;
  cards: Card[];
  conclusions: Conclusion[];
  /** how many record files exist, plus the project file's rev. only ever goes up. */
  revision: number;
}
