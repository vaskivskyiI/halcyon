// node --test reporter for GitHub Actions: each failing test becomes an ::error annotation (name and message), which
// GitHub shows on the run page — and through its public API — without opening the logs.
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export default async function* githubReporter(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:fail') continue;
    const err = ev.data.details?.error;
    // A file or suite "failed" only because one of its tests did: that test is reported itself. Setup failures
    // (a before() hook that cannot reach the server) are reported on the file.
    if (err?.failureType === 'subtestsFailed') continue;
    const cause = err?.cause || err;
    const msg = [cause?.message || String(cause || 'failed'), cause?.expected !== undefined ? `expected: ${JSON.stringify(cause.expected)}` : '', cause?.actual !== undefined ? `actual: ${JSON.stringify(cause.actual)}` : '']
      .filter(Boolean).join('\n').slice(0, 1500);
    const file = ev.data.file ? ev.data.file.replace(/^.*?server\//, 'server/') : '';
    yield `::error ${file ? `file=${prop(file)},` : ''}title=${prop(ev.data.name)}::${esc(msg)}\n`;
  }
}
