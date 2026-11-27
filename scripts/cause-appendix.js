#!/usr/bin/env node
// Prints the contract's cause appendix from the compiled catalog. `--write` puts it into
// docs/verify-contract.md; test/verify/architecture.test.js fails when the two differ.
const fs = require('fs');
const path = require('path');

const STAGES = [
  ['project_wiring', 'Project wiring'],
  ['workspace_ready', 'Workspace ready'],
  ['device_ready', 'Device ready'],
  ['profile_linked', 'Profile linked'],
  ['delivered_matrix', 'Pushes'],
  ['recorded', "Customer.io's record"],
];
const HEADING = '## Appendix: every cause';
const CONTRACT = path.join(__dirname, '..', 'docs', 'verify-contract.md');

function appendix() {
  const { CAUSES } = require('../dist/verify/areas/push/causes');
  const lines = [
    HEADING,
    '',
    "Generated from the tool's catalog by `scripts/cause-appendix.js`. `severity` is `blocker` or `warning`; the second line is the remedy, as the tool prints it.",
  ];
  for (const [stage, title] of STAGES) {
    lines.push('', `### ${title} (\`${stage}\`)`, '');
    for (const [code, cause] of Object.entries(CAUSES)) {
      if (cause.stage !== stage) continue;
      lines.push(`- **\`${code}\`** · ${cause.severity} — ${cause.summary}`);
      lines.push(`  ${cause.remedy}${cause.docs ? ` ${cause.docs}` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** The contract with its appendix replaced: the appendix runs to the end of the file. */
function withAppendix(contract) {
  const at = contract.indexOf(HEADING);
  if (at < 0) throw new Error(`${CONTRACT} has no "${HEADING}" section`);
  return contract.slice(0, at) + appendix();
}

module.exports = { appendix, withAppendix, CONTRACT };

if (require.main === module) {
  const contract = fs.readFileSync(CONTRACT, 'utf8');
  if (process.argv.includes('--write')) {
    fs.writeFileSync(CONTRACT, withAppendix(contract));
  } else {
    process.stdout.write(appendix());
  }
}
