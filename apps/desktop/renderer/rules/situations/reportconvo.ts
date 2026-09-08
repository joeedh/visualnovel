/** The report pane's situations: whether the analyst has started, and what `report.open` said. */
import { situations } from './situation.js';
import { emptyReport, grantBox, type ReportControls } from '../reportconvo.js';

const boxes = (source: boolean, detail: boolean): ReportControls['boxes'] => ({
  source: grantBox(source, undefined, 'Let the analyst read this app’s source code'),
  detail: grantBox(detail, undefined, 'Let the analyst read the requests this app sent'),
});

const MOCK =
  'Not while this workspace is running with mock providers — a real model has to read the conversation.';

export const SITUATIONS = situations<ReportControls>(
  {
    name : 'setup',
    why: 'The setup card is up and the command accepts, so Start is offered with its cost as the tooltip.',
    state: {
      state   : emptyReport(),
      changing: false,
      check   : { state: 'accept', message: 'Reads 12 turns; about one model call.' },
      boxes   : boxes(false, false),
    },
  },
  {
    name : 'mock',
    why: 'The workspace runs with mock providers, so Start is refused with the command’s sentence.',
    state: {
      state   : emptyReport(),
      changing: false,
      check   : { state: 'refuse', message: MOCK },
      boxes   : boxes(false, false),
    },
  },
  {
    name : 'open',
    why: 'A conversation is open with source access granted, so that grant box is refused as already given.',
    state: {
      state: {
        ...emptyReport(),
        thread : { id: 't1', title: 'Casting' },
        granted: { source: true, detail: false },
      },
      changing: false,
      boxes   : boxes(true, false),
    },
  },
);
