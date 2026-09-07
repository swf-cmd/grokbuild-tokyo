'use strict';

// Validate packaged resources with a fresh profile and a test engine.
// No dependency on previous live QA transcripts, and no real generation.
if (!process.argv.includes('--packaged')) process.argv.push('--packaged');
require('../tests/ui-controls.cjs');
