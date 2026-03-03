const fs = require('fs');
const html = fs.readFileSync('details_dom.html', 'utf8');
const classes = [...html.matchAll(/class="([^"]*(?:description|details|rail)[^"]*)"/gi)].map(m => m[1]);
console.log('Classes:', [...new Set(classes)].filter(c => c.includes('job')).slice(0, 30));
