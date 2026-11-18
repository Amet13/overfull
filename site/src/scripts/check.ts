/**
 * The browser check. Everything runs here, in the page: files (also a project
 * .zip or a dropped folder, unpacked by ./zip) are read with the File API and
 * analysed by @overfull/core in ./pipeline (which has no DOM). The only network
 * requests are reference lookups, when the user leaves "Verify references online"
 * on: core's sources 'crossref', 'doi.org' and 'openalex'. CrossRef gets each title with the first
 * author's surname and year; doi.org gets each DOI (and arXiv's DOI for an
 * arXiv id) and redirects it to the DOI's registration agency (CrossRef or
 * DataCite); OpenAlex gets a DOI or title that the others could not settle.
 * arXiv and dblp send no CORS headers, so they are never asked (see the CSP in
 * astro.config.mjs). pdf.js is loaded only when a PDF is checked.
 */
import {
  formatHtml,
  formatJson,
  formatMarkdown,
  type PdfjsLike,
  type RefCache,
  type Report,
} from '@overfull/core';
import { esc, renderSheet } from '../lib/sheet';
import { readWithinLimits } from './loose';
import { emptyFiles, type Kind, type Loaded, runBrowserCheck } from './pipeline';
import {
  CONFIG_FILE,
  chooseMain,
  type ProjectFile,
  profileFromConfig,
  projectKindOf,
  selectForMain,
} from './project';
import { readZip, selectPaths, ZIP_LIMITS, ZipError } from './zip';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
function must<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`check page: missing ${sel}`);
  return el;
}

function kindOf(name: string, head: string): Kind | null {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf') || head.startsWith('%PDF')) return 'pdf';
  if (n.endsWith('.bib')) return 'bib';
  if (n.endsWith('.aux') || n.endsWith('.bcf')) return 'aux';
  if (n.endsWith('.tex')) return 'tex';
  if (n.endsWith('.log') || n.endsWith('.txt') || /This is (Lua|pdf|Xe|e-)?(HB)?TeX/i.test(head))
    return 'log';
  if (/^\s*@\w+\s*[{(]/m.test(head)) return 'bib';
  return null;
}

/** In-memory lookup cache for the session (also kept in sessionStorage when allowed). */
function sessionCache(): RefCache {
  const KEY = 'overfull-refs-cache';
  let store: Record<string, unknown> = {};
  try {
    store = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    store = {};
  }
  return {
    get: (k) => store[k],
    set: (k, v) => {
      store[k] = v;
      try {
        sessionStorage.setItem(KEY, JSON.stringify(store));
      } catch {
        /* quota or disabled storage: keep it in memory */
      }
    },
  };
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
async function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfjsPromise;
}

export function initCheck(): void {
  const files: Loaded[] = [];
  const cache = sessionCache();
  const config = JSON.parse($('#check-config')?.textContent ?? '{}') as { rulesBase?: string };
  const samples = JSON.parse($('#samples-data')?.textContent ?? '[]') as {
    id: string;
    label: string;
    files: { name: string; text: string }[];
  }[];

  const form = must<HTMLFormElement>('#intake');
  const drop = must('#drop');
  const input = must<HTMLInputElement>('#file-input');
  const choose = must<HTMLButtonElement>('#choose');
  const list = must<HTMLUListElement>('#files');
  const filesWrap = must('#files-wrap');
  const runBtn = must<HTMLButtonElement>('#run');
  const stopBtn = must<HTMLButtonElement>('#stop');
  const online = must<HTMLInputElement>('#online');
  const profileSel = must<HTMLSelectElement>('#profile');
  const profileNote = must('#profile-note');
  const resultTitle = must('#result-title');
  const progress = must('#progress');
  const bar = must('#progress-bar');
  const barFill = must<HTMLElement>('#progress-bar span');
  const tools = must('#result-tools');
  const sheetView = must('#sheet-view');
  const agentView = must('#agent-view');
  const agentToggle = must<HTMLButtonElement>('#agent-toggle');
  const jsonOut = must('#json-out');
  const copyStatus = must('#copy-status');
  const notice = must('#notice');

  const folderInput = must<HTMLInputElement>('#folder-input');
  const chooseFolder = must<HTMLButtonElement>('#choose-folder');
  const mainPick = must('#main-pick');
  const mainSelect = must<HTMLSelectElement>('#main-select');

  let report: Report | null = null;
  /** The last unpacked project (.zip or folder), while its files are in use. */
  let project: { name: string; all: ProjectFile[]; main?: string } | null = null;
  /** Files the last drop or pick could not use; shown until the files change. */
  let skippedMsg = '';
  let controller: AbortController | null = null;
  let runId = 0;

  const say = (msg: string) => {
    progress.textContent = msg;
  };
  /** A message that stays until the next file change (unlike progress). */
  const note = (msg: string) => {
    notice.textContent = msg;
    notice.hidden = !msg;
  };
  const setBar = (fraction: number | null) => {
    bar.hidden = fraction === null;
    barFill.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
  };

  function renderFiles() {
    list.innerHTML = files
      .map(
        (f, i) =>
          `<li><span class="kind">${f.kind}</span><span class="name">${esc(f.name)}</span><button type="button" data-remove="${i}" aria-label="Remove ${esc(f.name)}">remove</button></li>`,
      )
      .join('');
    filesWrap.hidden = files.length === 0;
    runBtn.disabled = files.length === 0;
  }

  function add(loaded: Loaded[]) {
    for (const f of loaded) {
      const same = files.findIndex((x) => x.name === f.name && x.kind === f.kind);
      if (same >= 0) files.splice(same, 1, f);
      else files.push(f);
    }
    renderFiles();
  }

  function clearSamples() {
    for (const b of samples.length
      ? document.querySelectorAll<HTMLButtonElement>('[data-sample]')
      : [])
      b.setAttribute('aria-pressed', 'false');
  }

  function resetProject() {
    project = null;
    mainPick.hidden = true;
  }

  /** Puts the files of the chosen main file into the list and runs the check. */
  function applyMain(main: string | undefined, intro: string) {
    if (!project) return;
    project.main = main;
    const chosen = selectForMain(project.all, main);
    files.length = 0;
    add(
      chosen.map((f) => ({
        name: f.path,
        kind: f.kind,
        ...(f.data ? { data: f.data } : { text: f.text ?? '' }),
      })),
    );
    const count = (k: string) => chosen.filter((f) => f.kind === k).length;
    const bibs = count('bib');
    const found = [
      main ? `main file ${main}` : 'no main .tex file with a \\documentclass',
      `${bibs} .bib file${bibs === 1 ? '' : 's'}`,
      count('log') ? 'a build log' : 'no build log',
      count('pdf') ? 'a PDF' : 'no PDF',
      count('aux') ? 'an .aux or .bcf file' : 'no .aux or .bcf file',
    ].join(', ');
    skippedMsg = [`${project.name}: ${found}.`, intro].filter(Boolean).join(' ');
    note(skippedMsg);
    if (chosen.length) void run({ reveal: true });
    else say(`${project.name}: no .tex, .bib, .log, .aux, .bcf or .pdf files found.`);
  }

  /** Uses the `profile:` of the project's overfull.yml, as `overfull check` would. */
  function applyConfigProfile(config: string | undefined): string | undefined {
    const name = config === undefined ? undefined : profileFromConfig(config);
    if (!name) {
      profileNote.hidden = true;
      return config === undefined || !/^profile:/m.test(config)
        ? undefined
        : 'The profile settings in overfull.yml are applied only by `overfull check`.';
    }
    if (![...profileSel.options].some((o) => o.value === name)) {
      profileNote.hidden = true;
      return `overfull.yml names the profile ${name}, which this page does not know; choose one below.`;
    }
    profileSel.value = name;
    profileNote.hidden = false;
    return undefined;
  }

  /** Takes the files of a project, picks the main file (or asks) and runs. */
  function loadProject(name: string, all: ProjectFile[], notes: string[], config?: string) {
    files.length = 0;
    renderFiles();
    tools.hidden = true;
    clearSamples();
    project = { name, all };
    const choice = chooseMain(all);
    const configNote = applyConfigProfile(config);
    const intro = [...notes, ...(configNote ? [configNote] : [])].join(' ');
    if (choice.candidates.length > 1) {
      mainSelect.innerHTML = [
        `<option value="">Choose the main file…</option>`,
        ...choice.candidates.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`),
      ].join('');
      mainSelect.value = choice.main ?? '';
      mainPick.hidden = false;
      if (choice.main) {
        applyMain(choice.main, intro);
      } else {
        skippedMsg = [
          `${name}: ${choice.candidates.length} files could be the main file. Choose one below.`,
          intro,
        ]
          .filter(Boolean)
          .join(' ');
        note(skippedMsg);
        say('Choose the main file to run the check.');
      }
      return;
    }
    mainPick.hidden = true;
    applyMain(choice.main, intro);
  }

  const skippedNotes = (list: { path: string; reason: string }[]) =>
    list.length
      ? [
          `Left out: ${list
            .slice(0, 5)
            .map((s) => `${s.path} (${s.reason})`)
            .join(', ')}${list.length > 5 ? `, and ${list.length - 5} more` : ''}.`,
        ]
      : [];

  /** Loose files dropped with (or after) a project, by extension; names are the paths. */
  async function readLoose(
    list: File[],
  ): Promise<{ all: ProjectFile[]; skipped: string[]; notes: string[] }> {
    const all: ProjectFile[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    const used = { bytes: 0 };
    for (const file of list) {
      const kind = projectKindOf(file.name);
      if (!kind) {
        skipped.push(file.name);
        continue;
      }
      const read = await readWithinLimits(file, kind === 'log', used);
      if (!read.ok) {
        notes.push(`Skipped ${file.name}: ${read.reason}.`);
        continue;
      }
      if (read.note) notes.push(read.note);
      all.push(
        kind === 'pdf'
          ? { path: file.name, kind, data: read.data }
          : { path: file.name, kind, text: new TextDecoder('utf-8').decode(read.data) },
      );
    }
    if (skipped.length)
      notes.unshift(
        `Skipped ${skipped.join(', ')}: not a .log, .bib, .aux, .bcf, .tex or .pdf file.`,
      );
    return { all, skipped, notes };
  }

  const mergeFiles = (base: ProjectFile[], extra: ProjectFile[]) => [
    ...base.filter((f) => !extra.some((x) => x.path === f.path)),
    ...extra,
  ];

  async function readZipFile(file: File, others: File[]) {
    say(`Unpacking ${file.name} in your browser…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const zip = await readZip(buf, {
        filter: (p) => projectKindOf(p) !== null || p === CONFIG_FILE,
      });
      const all: ProjectFile[] = [];
      let config: string | undefined;
      for (const f of zip.files) {
        if (f.path === CONFIG_FILE) config = new TextDecoder('utf-8').decode(f.data);
        const kind = projectKindOf(f.path);
        if (!kind) continue;
        all.push(
          kind === 'pdf'
            ? { path: f.path, kind, data: f.data }
            : { path: f.path, kind, text: new TextDecoder('utf-8').decode(f.data) },
        );
      }
      const loose = await readLoose(others);
      const notes = [...skippedNotes(zip.skipped), ...loose.notes];
      loadProject(file.name, mergeFiles(all, loose.all), notes, config);
    } catch (err) {
      const msg =
        err instanceof ZipError
          ? err.message
          : `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
      skippedMsg = msg;
      note(msg);
      say(msg);
    }
  }

  /** A folder: files with a path relative to the folder's parent. */
  async function readFolder(items: { path: string; file: File }[], fallbackName: string) {
    say('Reading the folder in your browser…');
    try {
      const sel = selectPaths(items.map((i) => i.path));
      if (sel.kept.length + sel.skipped.length > ZIP_LIMITS.maxEntries)
        throw new Error(
          `This folder has ${sel.kept.length} files; the limit is ${ZIP_LIMITS.maxEntries}. Choose the project’s source folder only.`,
        );
      const total = sel.kept.reduce((n, k) => n + (items[k.index]?.file.size ?? 0), 0);
      if (total > ZIP_LIMITS.maxTotalBytes)
        throw new Error(
          `This folder is ${Math.ceil(total / 1048576)} MB; the limit is ${Math.round(ZIP_LIMITS.maxTotalBytes / 1048576)} MB. Choose the project’s source folder only.`,
        );
      const skipped = [...sel.skipped];
      const all: ProjectFile[] = [];
      let config: string | undefined;
      for (const k of sel.kept) {
        const kind = projectKindOf(k.path);
        const file = items[k.index]?.file;
        if (k.path === CONFIG_FILE && file && file.size < 1048576) config = await file.text();
        if (!kind || !file) continue;
        if (file.size > ZIP_LIMITS.maxEntryBytes) {
          skipped.push({ path: k.path, reason: 'file is too large' });
          continue;
        }
        const data = new Uint8Array(await file.arrayBuffer());
        all.push(
          kind === 'pdf'
            ? { path: k.path, kind, data }
            : { path: k.path, kind, text: new TextDecoder('utf-8').decode(data) },
        );
      }
      const root = items[0]?.path.split('/')[0];
      loadProject(
        items.every((i) => i.path.split('/')[0] === root) && root ? root : fallbackName,
        all,
        skippedNotes(skipped),
        config,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skippedMsg = msg;
      note(msg);
      say(msg);
    }
  }

  /** Walks dropped file-system entries (needs webkitGetAsEntry). */
  async function readDropped(entries: FileSystemEntry[]) {
    const out: { path: string; file: File }[] = [];
    let seen = 0;
    const readAll = async (dir: FileSystemDirectoryEntry) => {
      const reader = dir.createReader();
      const all: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
          reader.readEntries(res, rej),
        );
        if (!batch.length) return all;
        all.push(...batch);
      }
    };
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') return;
      if (++seen > ZIP_LIMITS.maxEntries * 4)
        throw new Error(
          `This folder has too many files; the limit is ${ZIP_LIMITS.maxEntries}. Choose the project’s source folder only.`,
        );
      if (entry.isDirectory) {
        for (const child of await readAll(entry as FileSystemDirectoryEntry))
          await walk(child, `${prefix}${entry.name}/`);
      } else {
        const file = await new Promise<File>((res, rej) =>
          (entry as FileSystemFileEntry).file(res, rej),
        );
        out.push({ path: `${prefix}${entry.name}`, file });
      }
    };
    try {
      say('Reading the folder in your browser…');
      for (const e of entries) await walk(e, '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skippedMsg = msg;
      note(msg);
      say(msg);
      return;
    }
    await readFolder(out, entries[0]?.name ?? 'folder');
  }

  async function readFiles(list: FileList | File[]) {
    const picked = Array.from(list);
    const zip = picked.find((f) => /\.zip$/i.test(f.name));
    if (zip) {
      await readZipFile(
        zip,
        picked.filter((f) => f !== zip),
      );
      return;
    }
    if (project) {
      // Files added to an unpacked project (its PDF or log, say) join it.
      const loose = await readLoose(picked);
      project.all = mergeFiles(project.all, loose.all);
      const notes = loose.notes;
      if (!mainPick.hidden && !mainSelect.value) {
        note(notes.join(' '));
        return;
      }
      applyMain(mainPick.hidden ? project.main : mainSelect.value, notes.join(' '));
      return;
    }
    resetProject();
    profileNote.hidden = true;
    const out: Loaded[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    const used = { bytes: 0 };
    for (const file of picked) {
      const head = new TextDecoder('latin1').decode(
        new Uint8Array(await file.slice(0, 2048).arrayBuffer()),
      );
      const kind = kindOf(file.name, head);
      if (!kind) {
        skipped.push(file.name);
        continue;
      }
      const read = await readWithinLimits(file, kind === 'log', used);
      if (!read.ok) {
        notes.push(`Skipped ${file.name}: ${read.reason}.`);
        continue;
      }
      if (read.note) notes.push(read.note);
      if (kind === 'pdf') out.push({ name: file.name, kind, data: read.data });
      else out.push({ name: file.name, kind, text: new TextDecoder('utf-8').decode(read.data) });
    }
    clearSamples();
    add(out);
    skippedMsg = [
      skipped.length
        ? `Skipped ${skipped.join(', ')}: not a .log, .bib, .aux, .bcf, .tex, .pdf or .zip file.`
        : '',
      ...notes,
    ]
      .filter(Boolean)
      .join(' ');
    note(skippedMsg);
    if (out.length) void run({ reveal: true });
  }

  // ----- Input wiring -----
  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files?.length) void readFiles(input.files);
    input.value = '';
  });
  folderInput.webkitdirectory = true;
  chooseFolder.hidden = !('webkitdirectory' in folderInput);
  chooseFolder.addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', () => {
    const picked = Array.from(folderInput.files ?? []);
    folderInput.value = '';
    if (!picked.length) return;
    void readFolder(
      picked.map((file) => ({ path: file.webkitRelativePath || file.name, file })),
      'folder',
    );
  });
  mainSelect.addEventListener('change', () => {
    if (mainSelect.value) applyMain(mainSelect.value, '');
  });
  for (const ev of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.dataset.active = 'true';
    });
  }
  for (const ev of ['dragleave', 'drop'] as const) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.dataset.active = 'false';
    });
  }
  drop.addEventListener('drop', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    // Entries must be taken now: the items are gone once the handler returns.
    const entries = Array.from(dt.items ?? [])
      .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
      .filter((x): x is FileSystemEntry => !!x);
    if (entries.some((x) => x.isDirectory)) void readDropped(entries);
    else if (dt.files.length) void readFiles(dt.files);
  });
  // Dropping outside the zone should not navigate away to the file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $<HTMLButtonElement>('#paste-add')?.addEventListener('click', () => {
    const text = $<HTMLTextAreaElement>('#paste-text')?.value ?? '';
    if (!text.trim()) {
      say('The paste box is empty.');
      return;
    }
    skippedMsg = '';
    resetProject();
    profileNote.hidden = true;
    add([{ name: 'pasted.log', kind: 'log', text }]);
    void run({ reveal: true });
  });

  list.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
    if (!btn) return;
    files.splice(Number(btn.dataset.remove), 1);
    renderFiles();
    (files.length ? runBtn : choose).focus();
    if (files.length) void run();
  });
  $<HTMLButtonElement>('#clear')?.addEventListener('click', () => {
    files.length = 0;
    renderFiles();
    resetProject();
    skippedMsg = '';
    note('');
    tools.hidden = true;
    choose.focus();
    say('All files removed.');
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-sample]')) {
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const s = samples.find((x) => x.id === btn.dataset.sample);
      if (!s) return;
      files.length = 0;
      skippedMsg = '';
      resetProject();
      for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sample]'))
        b.setAttribute('aria-pressed', String(b === btn));
      profileNote.hidden = true;
      add(
        s.files.map((f) => ({ name: f.name, kind: kindOf(f.name, f.text) ?? 'log', text: f.text })),
      );
      void run({ reveal: true });
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run({ reveal: true });
  });
  stopBtn.addEventListener('click', () => controller?.abort());
  online.addEventListener('change', () => {
    if (files.some((f) => f.kind === 'bib')) void run();
  });
  profileSel.addEventListener('change', () => {
    profileNote.hidden = true;
    if (files.length) void run();
  });

  agentToggle.addEventListener('click', () => {
    const on = agentToggle.getAttribute('aria-pressed') !== 'true';
    agentToggle.setAttribute('aria-pressed', String(on));
    agentView.hidden = !on;
    sheetView.hidden = on;
  });

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      copyStatus.textContent = `${what} copied.`;
    } catch {
      copyStatus.textContent = `Could not copy. Select the ${what} text and copy it by hand.`;
    }
    window.setTimeout(() => (copyStatus.textContent = ''), 4000);
  }
  $<HTMLButtonElement>('#copy-json')?.addEventListener(
    'click',
    () => report && void copy(formatJson(report), 'JSON'),
  );
  $<HTMLButtonElement>('#copy-md')?.addEventListener(
    'click',
    () => report && void copy(formatMarkdown(report), 'Markdown'),
  );
  // The same self-contained page as `overfull check --html`: to keep, print or send to
  // a co-author. Built here, so nothing leaves the computer.
  $<HTMLButtonElement>('#save-html')?.addEventListener('click', () => {
    if (!report) return;
    const blob = new Blob([formatHtml(report)], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'overfull-report.html';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    copyStatus.textContent = 'Report saved.';
    window.setTimeout(() => (copyStatus.textContent = ''), 4000);
  });

  /**
   * After a run the user started (files, a sample, Run check), focus moves to the
   * result heading, so a screen reader reads on from the report; in the
   * single-column layout (phones) the report is scrolled into view, since it
   * sits below the inputs.
   */
  function reveal() {
    resultTitle.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 979px)').matches) {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      resultTitle.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  // ----- The run -----
  async function run(opts: { reveal?: boolean } = {}) {
    if (!files.length) return;
    const id = ++runId;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    runBtn.disabled = true;
    const empty = emptyFiles(files);
    const emptyMsg = empty.length
      ? `${empty.map((f) => f.name).join(', ')}: the file is empty.`
      : '';
    const pdfs = files.filter((f) => f.kind === 'pdf' && !empty.includes(f));
    const multiPdf =
      pdfs.length > 1 ? `One PDF at a time; checking the first: ${pdfs[0]?.name}.` : '';
    note([skippedMsg, emptyMsg, multiPdf].filter(Boolean).join(' '));

    let result: Awaited<ReturnType<typeof runBrowserCheck>>;
    try {
      result = await runBrowserCheck(files, {
        profile: profileSel.value,
        online: online.checked,
        target: project
          ? `${project.name}${project.main ? ` (main file: ${project.main})` : ''}`
          : files
              .filter((f) => f.kind !== 'pdf' || f === pdfs[0])
              .map((f) => f.name)
              .join(', '),
        loadPdfjs: async () => (await loadPdfjs()) as unknown as PdfjsLike,
        cache,
        signal,
        onProgress: (msg, fraction) => {
          say(msg);
          if (fraction !== undefined) setBar(fraction);
        },
        onLookups: (running) => {
          stopBtn.hidden = !running;
          if (!running) setBar(null);
        },
        isCurrent: () => id === runId,
      });
    } catch (err) {
      if (id !== runId) return;
      console.warn(err);
      say(`The check stopped with an error: ${err instanceof Error ? err.message : String(err)}`);
      runBtn.disabled = false;
      stopBtn.hidden = true;
      setBar(null);
      return;
    }
    if (!result || id !== runId) return;
    report = result.report;
    const checks = report.checks;

    note([skippedMsg, emptyMsg, multiPdf, result.pdfError].filter(Boolean).join(' '));
    const rulesBase = config.rulesBase ?? '/rules/';
    sheetView.innerHTML = renderSheet(report, {
      // Uncommon veraPDF clause ids have no page; the 404 page forwards them.
      ruleHref: (r) => `${rulesBase}${r}/`,
      headingLevel: 3,
    });
    jsonOut.textContent = formatJson(report);
    tools.hidden = false;
    runBtn.disabled = false;
    const n = checks.flatMap((c) => c.problems);
    const errors = n.filter((p) => p.severity === 'error').length;
    const warnings = n.filter((p) => p.severity === 'warning').length;
    const ran = checks.filter((c) => c.status !== 'skipped').length;
    say(
      ran === 0 && empty.length
        ? `Done. ${empty.map((f) => f.name).join(', ')}: the file is empty, so there is nothing to check.`
        : `Done. ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} across ${ran} check${ran === 1 ? '' : 's'}.`,
    );
    if (opts.reveal) reveal();
  }
}
