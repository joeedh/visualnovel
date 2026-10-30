import { docCreate, docRead, docRename, docSaveAll, docWrite } from './doc.js';
import { docCopy, docDelete, docMkdir, docMove, docNewFile } from './docfiles.js';

export const docsCommands = [
  docCopy,
  docCreate,
  docDelete,
  docMkdir,
  docMove,
  docNewFile,
  docRead,
  docSaveAll,
  docRename,
  docWrite,
];
