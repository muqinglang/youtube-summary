(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const store = {get(k, fallback) {try {return JSON.parse(localStorage.getItem('sidenote-'+k)) ?? fallback;} catch{return fallback;}},set(k,v){try{localStorage.setItem('sidenote-'+k,JSON.stringify(v));}catch{}}};
  const storedTime=Number(store.get('position',92));
  let time=store.get('remember',true)&&Number.isFinite(storedTime)?Math.max(0,Math.min(1122,storedTime)):92;
  let playing=false, language=store.get('language','zh-CN'), mode=store.get('mode','bilingual'), captions=true, toastTimer, tourIndex=0, previousFocus;
  let lastStored=-1, tourStartScroll=0;
  const iconUrl=name=>window.SIDENOTE_ICONS?.[name]||`assets/icons/${name}.svg`;
  const format = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  function toast(text){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3400);}
  window.LearningPanel.init({root:$('#learning-panel'),seek,toast});
  function seek(seconds){time=Math.min(1122,Math.max(0,Number(seconds)||0));renderTime();}
  function renderTime(){
    $('#timeline').value=time;$('#timeline').style.setProperty('--progress',(time/1122*100)+'%');$('#timeline').setAttribute('aria-valuetext',`${format(time)} / 18:42`);$('#current-time').textContent=format(time);
    const caption=window.LearningPanel.getCaption(time,language);$('#caption-en').textContent=caption.en;$('#caption-translation').textContent=caption.translated;
    $('#caption-en').hidden=mode==='translated';$('#caption-translation').hidden=mode==='original'||(language==='en'&&mode==='bilingual');
    window.LearningPanel.updateTime(time);
    const chapters=[...document.querySelectorAll('#chapters [data-seek]')];let active=chapters.filter(el=>Number(el.dataset.seek)<=time).pop();chapters.forEach(el=>{el.classList.toggle('selected',el===active);el.setAttribute('aria-current',el===active?'true':'false');});
    if($('#remember-position').checked&&Math.floor(time)!==lastStored){lastStored=Math.floor(time);store.set('position',time);}
  }
  function togglePlay(force){playing=typeof force==='boolean'?force:!playing;if(playing&&time>=1122)time=0;$('#video-frame').classList.toggle('playing',playing);$('#play-state').hidden=!playing;['#play-toggle','#frame-play'].forEach(s=>{$(s).setAttribute('aria-label',playing?'暂停演示播放':'开始演示播放');$(s).querySelector('img').src=iconUrl(`player-${playing?'pause':'play'}-filled`);});}
  let lastTick=performance.now();const ticker=setInterval(()=>{const now=performance.now();if(playing){time=Math.min(1122,time+(now-lastTick)/1000*Number($('#speed').value));renderTime();if(time>=1122)togglePlay(false);}lastTick=now;},250);
  $('#frame-play').addEventListener('click',()=>togglePlay());$('#play-toggle').addEventListener('click',()=>togglePlay());$('#back-ten').addEventListener('click',()=>seek(time-10));$('#forward-ten').addEventListener('click',()=>seek(time+10));$('#timeline').addEventListener('input',e=>seek(e.target.value));
  document.querySelectorAll('#chapters [data-seek]').forEach(el=>el.addEventListener('click',()=>seek(el.dataset.seek)));
  $('#target-language').value=language;$('#subtitle-mode').value=mode;window.LearningPanel.setLanguage(language);window.LearningPanel.setDisplayMode?.(mode);
  $('#target-language').addEventListener('change',e=>{language=e.target.value;store.set('language',language);window.LearningPanel.setLanguage(language);renderTime();toast('已切换示例译文；正式版将使用 AI 翻译');});
  $('#subtitle-mode').addEventListener('change',e=>{mode=e.target.value;store.set('mode',mode);window.LearningPanel.setDisplayMode?.(mode);renderTime();});
  $('#captions-toggle').addEventListener('click',()=>{captions=!captions;$('#subtitle-stage').hidden=!captions;$('#captions-toggle').classList.toggle('active',captions);$('#captions-toggle').setAttribute('aria-pressed',captions);$('#captions-toggle').setAttribute('aria-label',captions?'隐藏双语字幕':'显示双语字幕');});
  $('#focus-toggle').addEventListener('click',()=>{const focus=document.body.classList.toggle('cinema');$('#focus-toggle span').textContent=focus?'退出影院':'影院模式';$('#focus-toggle').setAttribute('aria-pressed',focus);});
  $('#fullscreen-toggle').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if($('#player').requestFullscreen)await $('#player').requestFullscreen();else toast('当前浏览器不支持全屏，请使用影院模式');}catch{toast('当前预览环境不支持全屏，请使用影院模式');}});
  let saved=store.get('bookmark',false);function renderBookmark(){$('#bookmark').classList.toggle('active',saved);$('#bookmark').setAttribute('aria-pressed',saved);$('#bookmark').setAttribute('aria-label',saved?'取消收藏示例课程':'收藏示例课程');}renderBookmark();$('#bookmark').addEventListener('click',()=>{saved=!saved;store.set('bookmark',saved);renderBookmark();toast(saved?'已收藏到本地学习记录':'已取消收藏');});
  $('#tip-close').addEventListener('click',()=>{$('#welcome-tip').hidden=true;});
  $('#font-size').value=store.get('font-size','medium');$('#caption-background').checked=store.get('caption-background',true);$('#remember-position').checked=store.get('remember',true);
  function applySettings(){$('#subtitle-stage').classList.toggle('caption-small',$('#font-size').value==='small');$('#subtitle-stage').classList.toggle('caption-large',$('#font-size').value==='large');$('#subtitle-stage').classList.toggle('no-background',!$('#caption-background').checked);store.set('font-size',$('#font-size').value);store.set('caption-background',$('#caption-background').checked);store.set('remember',$('#remember-position').checked);}
  ['#font-size','#caption-background','#remember-position'].forEach(s=>$(s).addEventListener('change',applySettings));applySettings();
  $('#settings-open').addEventListener('click',()=>$('#settings-dialog').showModal());document.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',()=>document.getElementById(el.dataset.close).close()));
  document.querySelectorAll('.app-dialog').forEach(d=>d.addEventListener('click',e=>{const r=d.getBoundingClientRect();if(e.target===d&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))d.close();}));

  const checks=['整体布局与深色风格','双语字幕与语言切换','字幕跟随与时间点跳转','AI 总结与自定义 Prompt','思维导图与导出入口','AI 问答与操作引导'];let reviewed=store.get('reviewed',[]);
  checks.forEach((text,i)=>{const label=document.createElement('label');label.className='review-item';const input=document.createElement('input');input.type='checkbox';input.checked=reviewed.includes(i);input.addEventListener('change',()=>{reviewed=[...document.querySelectorAll('.review-item input')].map((el,index)=>el.checked?index:null).filter(v=>v!==null);store.set('reviewed',reviewed);renderReview();});label.append(input,document.createTextNode(text));$('#review-checks').append(label);});
  function renderReview(){$('#review-progress').textContent=`已确认 ${reviewed.length} / ${checks.length} 项`;}
  $('#review-notes').value=store.get('review-notes','');$('#review-notes').addEventListener('input',e=>store.set('review-notes',e.target.value));renderReview();$('#review-open').addEventListener('click',()=>$('#review-dialog').showModal());
  $('#download-review').addEventListener('click',()=>{const content=`# 旁听 UI 设计验证反馈\n\n${checks.map((c,i)=>`- [${reviewed.includes(i)?'x':' '}] ${c}`).join('\n')}\n\n## 修改建议\n${$('#review-notes').value||'暂无'}\n\n此文件仅验证设计，不代表真实插件已开发。\n`;const url=URL.createObjectURL(new Blob(['\uFEFF',content],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='旁听-UI验证反馈.md';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);toast('已下载验证反馈，请将文件或修改意见发给我');});

  const steps=[
    {target:'#player',title:'先看，再深入理解',text:'左侧保留完整观看空间。点击播放按钮，体验字幕随时间切换；拖动进度条或点击章节，可以跳到对应位置。当前为静态画面与演示进度。'},
    {target:'#language-bar',title:'用熟悉的语言学习',text:'切换中文、日语、西班牙语或法语。也可以选择双语对照、仅原文或仅译文，按自己的水平调整。'},
    {target:'#lp-transcript',tab:'transcript',title:'字幕就是你的内容导航',text:'右侧字幕高亮当前句，并自动跟随播放。点击句子就能跳转；手动浏览时暂停跟随，再点“跟随播放”回到当前位置。'},
    {target:'#lp-prompt-btn',tab:'summary',title:'让总结按你的方式输出',text:'进入 AI 总结查看全片概览和章节重点。打开 Prompt，可编辑总结要求、切换模板并保存；Demo 只展示预设结果，不会调用 AI。'},
    {target:'#lp-export-btn',tab:'mindmap',title:'把视频变成知识结构',text:'展开或收起思维导图，再从“导出”选择 PDF、Markdown 或 XMind。PDF 可打印保存，Markdown 可下载；XMind 在 Demo 中展示导出流程。'},
    {target:'#lp-question',tab:'qa',title:'带着问题回看视频',text:'输入问题或选择快捷提问，体验带时间点的演示回答。验证完成后，通过页面底部的“验证清单”记录你的修改意见。'}
  ];
  function positionTour(){const step=steps[tourIndex];let target=$(step.target)||$('#learning-panel');const r=target.getBoundingClientRect();const pad=5;const left=Math.max(8,r.left-pad),top=Math.max(8,r.top-pad),right=Math.min(innerWidth-8,r.right+pad),bottom=Math.min(innerHeight-8,r.bottom+pad);Object.assign($('#tour-focus').style,{left:left+'px',top:top+'px',width:Math.max(30,right-left)+'px',height:Math.max(30,bottom-top)+'px'});const card=$('#tour-card'),w=card.offsetWidth,h=card.offsetHeight;let x=r.right+18,y=r.top;if(x+w>innerWidth-16)x=r.left-w-18;if(x<16){x=Math.max(16,(innerWidth-w)/2);y=r.bottom+18;if(y+h>innerHeight-16)y=r.top-h-18;}x=Math.max(16,Math.min(innerWidth-w-16,x));y=Math.max(16,Math.min(innerHeight-h-16,y));Object.assign(card.style,{left:x+'px',top:y+'px'});}
  function renderTour(){const step=steps[tourIndex];if(step.tab)window.LearningPanel.showTab(step.tab);$('#tour-title').textContent=step.title;$('#tour-description').textContent=step.text;$('#tour-counter').textContent=`0${tourIndex+1} / 0${steps.length}`;$('#tour-prev').disabled=tourIndex===0;$('#tour-next').textContent=tourIndex===steps.length-1?'开始体验 ✓':'下一步 →';$('#tour-dots').replaceChildren(...steps.map((_,i)=>{const el=document.createElement('i');el.className='tour-dot'+(tourIndex===i?' current':'');return el;}));const target=$(step.target)||$('#learning-panel');target.scrollIntoView({behavior:'instant',block:'nearest'});requestAnimationFrame(positionTour);}
  function closeTour(){$('#tour-dialog').close();store.set('tour-seen',true);window.LearningPanel.showTab('transcript');previousFocus?.focus({preventScroll:true});window.scrollTo({top:tourStartScroll,behavior:'instant'});}
  $('#guide-start').addEventListener('click',()=>{togglePlay(false);previousFocus=document.activeElement;tourStartScroll=window.scrollY;tourIndex=0;$('#tour-dialog').showModal();renderTour();$('#tour-next').focus();});$('#tour-close').addEventListener('click',closeTour);$('#tour-dialog').addEventListener('cancel',e=>{e.preventDefault();closeTour();});$('#tour-next').addEventListener('click',()=>{if(tourIndex===steps.length-1){closeTour();return;}tourIndex++;renderTour();});$('#tour-prev').addEventListener('click',()=>{if(tourIndex>0)tourIndex--;renderTour();});window.addEventListener('resize',()=>{if($('#tour-dialog').open)positionTour();});
  document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat&&!document.querySelector('dialog[open]')&&!e.target.closest('input,textarea,select,button,a,[contenteditable="true"]')){e.preventDefault();togglePlay();}});
  window.addEventListener('pagehide',()=>{clearInterval(ticker);});renderTime();
})();
