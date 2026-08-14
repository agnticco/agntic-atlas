/**
 * What to say when Atlas has no AI model configured.
 *
 * This is the FIRST WALL a self-hoster hits. They clone the repo, run `npm start`,
 * sign up, type a sentence describing what they want automated — and if no API key
 * is set they used to get the words "LLM unavailable". That is true, and it is
 * useless: it names an internal component, not the thing they have to do. Someone
 * evaluating Atlas in their first two minutes concludes it is broken and leaves.
 *
 * Atlas boots fine without a key on purpose — the console, the connectors, sign-in
 * and the whole test suite work without one — so refusing to start would be wrong.
 * The honest design is: boot, but the moment something actually needs a model, say
 * exactly what is missing and exactly how to fix it.
 *
 * ONE message, several readers (the chat stream, two builder endpoints, and the
 * engine's llm/decision nodes) rather than each inventing its own wording. Two
 * copies of one sentence drifting apart is the shape this codebase has paid for
 * repeatedly — and here it would mean a person is told two different things about
 * the same missing key depending on which screen they were on.
 */

/**
 * True when this deployment has some usable model. Mirrors buildLLM()'s own
 * precedence (Anthropic → OpenAI → local weights) rather than re-deciding it; the
 * local path is reported by the caller, which is the only thing that knows whether
 * the weights file is actually on disk.
 */
export function hasCloudModelKey() {
  return !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
}

/**
 * The sentence a PERSON reads. No component names, no variable names in isolation
 * — the environment variable is named because it is the thing they must type, and
 * it appears with the file it goes in and the step that follows.
 */
export const NO_MODEL_MESSAGE =
  'Atlas has no AI model set up yet, so it cannot build or run anything that needs one. '
  + 'Add an API key to the .env file in your Atlas folder — ANTHROPIC_API_KEY=sk-ant-... '
  + '(or OPENAI_API_KEY=sk-...) — then restart Atlas. '
  + 'You can get an Anthropic key at https://console.anthropic.com/settings/keys.';

/** The same fact, shortened for a log line or an error field. */
export const NO_MODEL_SHORT = 'no AI model configured — set ANTHROPIC_API_KEY in .env and restart';

/**
 * The boot banner. Framed and printed on its own lines so it is not lost in the
 * startup noise — the same treatment the first-run setup token gets, and for the
 * same reason: it is a thing the operator must act on before Atlas is useful.
 */
export function printNoModelBanner(log = console) {
  // Padding is COMPUTED, not typed. A hand-aligned ASCII box is wrong the first
  // time anyone edits a word in it, and a crooked banner reads as a broken program
  // — which is the opposite of the reassurance this message exists to give.
  const body = [
    'ATLAS HAS NO AI MODEL CONFIGURED',
    '',
    'Atlas will start, and you can sign in and look around, but',
    'building or running a workflow needs a model.',
    '',
    'Add ONE of these to the .env file in your Atlas folder,',
    'then restart Atlas:',
    '',
    '    ANTHROPIC_API_KEY=sk-ant-...   (recommended)',
    '    OPENAI_API_KEY=sk-...',
    '',
    'Get an Anthropic key:',
    'https://console.anthropic.com/settings/keys',
  ];
  const width = Math.max(...body.map((l) => l.length)) + 4;
  const rule  = '─'.repeat(width);
  const rows  = body.map((l) => `│  ${l.padEnd(width - 4)}  │`).join('\n');
  log.warn(`\n┌${rule}┐\n${rows}\n└${rule}┘\n`);
}
