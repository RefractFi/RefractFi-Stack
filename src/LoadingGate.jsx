import React,{useEffect,useState} from 'react';
import AbstractCubeIsometricLoader from './components/ui/abstract-cube-isometric-loader';
import {heroImages,aboutOrbitImages,aboutSphereImages,aboutIndexImages} from './storyImages';
import './loading.css';
const base=['/assets/logo.png','/assets/logo-traced.svg'];
const routeAssets=path=>{
 if(path==='/')return [...base,...heroImages,...["6385891", "6466141", "6466143", "6477199"].map(i=>`/assets/tech-stock/${i}.jpg`),...[1,2,3].map(i=>`/assets/circuit-${i}.jpg`),...['38781822','40342987','1624895'].map(i=>`/assets/protocol-stock/${i}.jpg`)];
 if(path.startsWith('/about'))return [...base,...aboutOrbitImages,...aboutSphereImages,...aboutIndexImages];
 if(path==='/protocol')return [...base,...["6477207", "40342985", "37605910", "6755086", "2881229", "7174676", "17489155", "32194418", "15559037"].map(i=>`/assets/${["6755086","7174676"].includes(i)?"tech-stock":"protocol-stock"}/${i}.jpg`)];
 if(path==='/learn')return [...base,'/assets/insight-01.jpg',...["6477204", "6477213", "6636497", "6636500", "6755074"].map(i=>`/assets/tech-stock/${i}.jpg`)];
 return base;
};
const cleanPath=()=>location.pathname.replace(/\/$/,'')||'/';
export default function LoadingGate({children}){
 const path=cleanPath(),dashboard=path==='/dashboard';
 const [ready,setReady]=useState(false),[sceneReady,setSceneReady]=useState(path!=='/'||!!location.hash),[progress,setProgress]=useState(0),[depart,setDepart]=useState(false),[show,setShow]=useState(true);
 useEffect(()=>{
  let live=true,done=0;const assets=routeAssets(path),total=assets.length+2;
  const tick=()=>{if(live)setProgress(Math.round(++done/total*100))};
  const jobs=assets.map(src=>new Promise(resolve=>{const image=new Image();image.onload=()=>{const finish=()=>{tick();resolve()};if(image.decode)image.decode().catch(()=>{}).then(finish);else finish()};image.onerror=()=>{tick();resolve()};image.src=src}));
  const fonts=document.fonts?Promise.allSettled([document.fonts.load('600 16px "Inter Tight"'),document.fonts.load('400 16px "IBM Plex Mono"'),document.fonts.ready]):Promise.resolve();jobs.push(fonts.then(tick));const pageModule=path==='/'?import('./StoryHero'):path.startsWith('/about')?import('./AboutPage'):path==='/dashboard'?import('./Dashboard'):Promise.resolve();jobs.push(pageModule.catch(()=>{}).then(tick));
  Promise.all(jobs).then(()=>{if(live)setReady(true)});
  return()=>{live=false};
 },[path]);
 useEffect(()=>{const finish=()=>setSceneReady(true);window.addEventListener('refractfi:scene-ready',finish);const timeout=window.setTimeout(finish,8000);return()=>{window.removeEventListener('refractfi:scene-ready',finish);window.clearTimeout(timeout)}},[]);
 useEffect(()=>{if(!ready||!sceneReady)return;const timer=window.setTimeout(()=>setShow(false),250);return()=>window.clearTimeout(timer)},[ready,sceneReady]);
 useEffect(()=>{if(ready&&location.hash){requestAnimationFrame(()=>{try{document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView()}catch{}})}},[ready]);
 useEffect(()=>{const restore=()=>document.documentElement.classList.remove('route-departing');window.addEventListener('pageshow',restore);return()=>window.removeEventListener('pageshow',restore)},[]);
 useEffect(()=>{const warmed=new Set();const warm=a=>{if(!a)return;const url=new URL(a.href,location.href);if(url.origin!==location.origin)return;const next=url.pathname.replace(/\/$/,'')||'/';if(warmed.has(next))return;warmed.add(next);routeAssets(next).forEach(src=>{const image=new Image();image.src=src});if(next==='/dashboard')import('./Dashboard');else if(next.startsWith('/about'))import('./AboutPage');else if(next==='/')import('./StoryHero')};const onIntent=e=>warm(e.target instanceof Element?e.target.closest('a[href]'):null);const onClick=e=>{const a=e.target instanceof Element?e.target.closest('a[href]'):null;if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||a.target||a.hasAttribute('download'))return;const url=new URL(a.href,location.href);if(url.origin!==location.origin||url.pathname===location.pathname||url.hash&&url.pathname===location.pathname)return;warm(a);if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;e.preventDefault();document.documentElement.classList.add('route-departing');window.setTimeout(()=>location.assign(url.href),160)};document.addEventListener('pointerover',onIntent,{passive:true});document.addEventListener('touchstart',onIntent,{passive:true});document.addEventListener('focusin',onIntent);document.addEventListener('click',onClick);return()=>{document.removeEventListener('pointerover',onIntent);document.removeEventListener('touchstart',onIntent);document.removeEventListener('focusin',onIntent);document.removeEventListener('click',onClick)}},[path]);
 return <>{ready&&children}{(show||depart)&&<div className={'page-loading '+((dashboard||depart)?'is-dashboard-loader ':'')+((ready&&sceneReady&&!depart)?'is-leaving':'')} role="status" aria-live="polite">{(dashboard||depart)?<><AbstractCubeIsometricLoader dotSize={6} gap={5} speed={1.2} color="#d5e3e0" bloom/><span>Opening dashboard</span></>:<><div className="loading-mark"><img src="/assets/logo-traced.svg" alt=""/></div><span className="loading-count">{progress.toString().padStart(2,'0')}<small>%</small></span></>}</div>}</>;
}
