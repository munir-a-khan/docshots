// One job reads one doc. What the doc lists are "entries"; in a Warframe log they are arbitration "runs".
export const wordsFor = preset => (preset === 'warframe'
  ? { item: 'run', items: 'runs', Item: 'Run', Items: 'Runs', shot: 'screenshot', shots: 'screenshots' }
  : { item: 'entry', items: 'entries', Item: 'Entry', Items: 'Entries', shot: 'image', shots: 'images' });
