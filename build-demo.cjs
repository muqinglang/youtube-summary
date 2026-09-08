// Bundles the prototype into one offline HTML file. No packages or build framework required.
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
const icons={};
for(const name of fs.readdirSync(path.join(__dirname,'assets/icons')).filter(name=>name.endsWith('.svg'))){icons[name.slice(0,-4)]='data:image/svg+xml;base64,'+fs.readFileSync(path.join(__dirname,'assets/icons',name)).toString('base64');}
const script=text=>text.replace(/<\/script/gi,'<\\/script');
let html=read('index.html').replace('<link rel="stylesheet" href="styles.css">',()=>'<style>'+read('styles.css')+'</style>').replace('<link rel="stylesheet" href="panel.css">',()=>'<style>'+read('panel.css')+'</style>').replace('  <script defer src="panel.js"></script>','').replace('  <script defer src="app.js"></script>','').replace('href="index.html"','href="#"');
html=html.replace(/src="assets\/icons\/([^"/]+)\.svg"/g,(_,name)=>'src="'+icons[name]+'"').replace('src="assets/reference-video.png"','src="data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'assets/reference-video.png')).toString('base64')+'"');
html=html.replace('</body>',()=>'<script>window.SIDENOTE_ICONS='+JSON.stringify(icons)+';</script><script>'+script(read('panel.js'))+'</script><script>'+script(read('app.js'))+'</script></body>');
fs.writeFileSync(path.join(__dirname,'sidenote-demo.html'),html);
console.log('Built sidenote-demo.html ('+Math.round(Buffer.byteLength(html)/1024)+' KB), standalone and offline.');
