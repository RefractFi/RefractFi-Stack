import logoSvg from './assets/logo-traced.svg?raw';
import React, {useEffect, useRef} from 'react';
import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

// GetLayers SVG-to-3D geometry and studio-lighting recipe, adapted to clear glass.
const SVG = logoSvg;
export default function GlassA({className='', context='hero'}) {
 const host=useRef(null);
 useEffect(()=>{
  const el=host.current; if(!el)return;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  let renderer,raf=0,alive=true,visible=false,last=0, time=0;
  try{
   THREE.ColorManagement.enabled=true;
   renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
   renderer.setClearColor(0x090b0d,0); renderer.outputColorSpace=THREE.SRGBColorSpace;
   renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
   el.appendChild(renderer.domElement);
   const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(36,1,1,5000);camera.position.set(0,0,420);camera.lookAt(0,0,0);
   const pmrem=new THREE.PMREMGenerator(renderer),env=pmrem.fromScene(new RoomEnvironment(),0.04); scene.environment=env.texture;
   const parsed=new SVGLoader().parse(SVG), shapes=parsed.paths.flatMap(p=>SVGLoader.createShapes(p));
   const scale=200/444;const geometry=new THREE.ExtrudeGeometry(shapes,{depth:7/scale,bevelEnabled:true,bevelSize:.18/scale,bevelThickness:(.18/scale)*(2.4/1.45),bevelOffset:-.2*.18/scale,bevelSegments:4,curveSegments:14,steps:1});
   geometry.center();geometry.scale(scale,-scale,scale);geometry.computeVertexNormals();
   const mesh=new THREE.Mesh(geometry,[new THREE.MeshPhysicalMaterial({color:0xcad9da,metalness:0,roughness:.035,transmission:1,thickness:18,ior:1.48,clearcoat:1,clearcoatRoughness:.05,envMapIntensity:1.2,transparent:true,opacity:.72,depthWrite:false,side:THREE.DoubleSide}),new THREE.MeshPhysicalMaterial({color:0xb8cbd0,metalness:0,roughness:.065,transmission:.98,thickness:22,ior:1.48,clearcoat:1,envMapIntensity:1.3,transparent:true,opacity:.70,depthWrite:false,side:THREE.DoubleSide})]);
   const object=new THREE.Group(); object.add(mesh);const edgeGeometry=new THREE.EdgesGeometry(geometry,60);const edgeMaterial=new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.78});const edges=new THREE.LineSegments(edgeGeometry,edgeMaterial);object.add(edges);scene.add(object); RectAreaLightUniformsLib.init();scene.add(new THREE.AmbientLight(0xffffff,.28));
   function area(color,power,w,h,x,y,z,tx=0,ty=0){const l=new THREE.RectAreaLight(color,power,w,h);l.position.set(x,y,z);l.lookAt(tx,ty,0);scene.add(l)}
   area(0xf4f8f6,5,240,300,-90,-40,170);area(0xdce8ef,24,72,520,-165,20,-60,-18);area(0xe8efef,22,72,520,165,10,-58,18);area(0xffffff,10,150,300,120,90,160);
   const resize=()=>{let w=el.clientWidth,h=el.clientHeight;if(!w||!h)return;let d=Math.min(devicePixelRatio||1,innerWidth<700?1.4:1.75);renderer.setPixelRatio(d);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();if(reduced.matches)renderer.render(scene,camera)};
   const ro=new ResizeObserver(resize);ro.observe(el);resize();
   const floating=el.closest('.floating-logo');
   const canRender=()=>alive&&visible&&(!floating||floating.style.visibility!=='hidden');
   function frame(now){raf=0;if(!canRender())return;let dt=Math.min(.05,(now-(last||now))/1000);last=now;if(!reduced.matches){time+=dt;object.rotation.y=Math.sin(time*.20)*.32;object.rotation.x=Math.sin(time*.26)*.045;object.rotation.z=-.08}renderer.render(scene,camera);if(!reduced.matches)raf=requestAnimationFrame(frame)}
   const start=()=>{if(canRender()&&!raf){last=0;raf=requestAnimationFrame(frame)}else if(!canRender()&&raf){cancelAnimationFrame(raf);raf=0}};
   const io=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;start()},{rootMargin:'100px'});io.observe(el);
   const observer=floating?new MutationObserver(start):null;if(observer)observer.observe(floating,{attributes:true,attributeFilter:['style']});
   const onMotion=()=>{cancelAnimationFrame(raf);raf=0;start()};reduced.addEventListener('change',onMotion);
   return()=>{alive=false;cancelAnimationFrame(raf);ro.disconnect();io.disconnect();observer?.disconnect();reduced.removeEventListener('change',onMotion);geometry.dispose();edgeGeometry.dispose();edgeMaterial.dispose();mesh.material.forEach(m=>m.dispose());env.dispose();pmrem.dispose();renderer.dispose();renderer.domElement.remove()};
  }catch(error){console.warn('3D visual unavailable',error);el.classList.add('glass-fallback');return()=>{alive=false;cancelAnimationFrame(raf);renderer?.dispose()}}
 },[context]);
 return <span ref={host} className={'glass-a '+className} aria-hidden="true"><img className="glass-a-fallback" src="/assets/logo-traced.svg" alt=""/></span>;
}
