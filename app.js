import * as THREE from "./vendor/three.module.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";

const stage=document.getElementById("stage");
const fileInput=document.getElementById("fileInput");
const loadRepoBtn=document.getElementById("loadRepoBtn");
const fitBtn=document.getElementById("fitBtn");
const clearBtn=document.getElementById("clearBtn");
const explodeBtn=document.getElementById("explodeBtn");
const opacityRange=document.getElementById("opacityRange");
const statusEl=document.getElementById("status");
const wrap=document.getElementById("stageWrap");
const dropHint=document.getElementById("dropHint");

let renderer,scene,camera,controls,loader,currentModel,raycaster,mouse,explodeState=false,partsInfo=null;
let pickMeshes=[],selected=new Set();

init();

function init(){
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:"high-performance"});
    renderer.setPixelRatio(Math.min(1.0,window.devicePixelRatio||1));
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure=1.3;
    stage.appendChild(renderer.domElement);

    scene=new THREE.Scene();

    camera=new THREE.PerspectiveCamera(50,1,0.1,5000);
    camera.position.set(6,4.5,6);

    controls=new OrbitControls(camera,renderer.domElement);
    controls.enableDamping=true;
    controls.dampingFactor=0.07;
    controls.addEventListener("change",render);

    const amb=new THREE.AmbientLight(0xffffff,0.85);
    const hemi=new THREE.HemisphereLight(0xffffff,0xa0a6b6,0.9);
    const key=new THREE.DirectionalLight(0xffffff,1.0);
    key.position.set(7,10,6);
    const fill=new THREE.DirectionalLight(0xffffff,0.6);
    fill.position.set(-6,6,-7);
    scene.add(amb,hemi,key,fill);

    loader=new GLTFLoader();
    raycaster=new THREE.Raycaster();
    mouse=new THREE.Vector2();

    resize();
    window.addEventListener("resize",onResizeThrottled);
    wireUI();
    setStatus("Готово. Загрузите файл или нажмите «Открыть models/model.glb».");
    render();
}

function wireUI(){
    fileInput.addEventListener("change",async e=>{
        const f=e.target.files?.[0];
        if(!f) return;
        const url=URL.createObjectURL(f);
        await loadGLB(url,f.name,true);
    });

    loadRepoBtn.addEventListener("click",async ()=>{
        try{
            setStatus("Загрузка models/model.glb …");
            await loadGLB("models/model.glb","model.glb",false);
        }catch(err){
            setStatus("Ошибка: "+(err?.message||err));
        }
    });

    ["dragenter","dragover"].forEach(t=>{
        stage.addEventListener(t,e=>{e.preventDefault();wrap.classList.add("dragover");});
    });
    ["dragleave","drop"].forEach(t=>{
        stage.addEventListener(t,e=>{e.preventDefault();wrap.classList.remove("dragover");});
    });
    stage.addEventListener("drop",async e=>{
        const f=e.dataTransfer?.files?.[0];
        if(!f) return;
        const url=URL.createObjectURL(f);
        await loadGLB(url,f.name,true);
    });

    fitBtn.addEventListener("click",()=>{fitView();render();});
    clearBtn.addEventListener("click",()=>{clearModel();render();});
    explodeBtn.addEventListener("click",()=>{toggleExplode();render();});
    opacityRange.addEventListener("input",()=>{applyOpacityToSelection();render();});
    stage.addEventListener("pointerdown",onPointerDown);
}

async function loadGLB(url,name,revoke){
    return new Promise((resolve,reject)=>{
        loader.load(url,gltf=>{
            setModel(gltf.scene||gltf.scenes?.[0]||gltf);
            fitView();
            setStatus("Готово: "+name);
            if(revoke) URL.revokeObjectURL(url);
            render();
            resolve();
        },undefined,err=>{
            if(revoke) URL.revokeObjectURL(url);
            reject(err);
        });
    });
}

function setModel(obj){
    clearModel();
    currentModel=obj;
    pickMeshes.length=0;
    currentModel.traverse(o=>{
        if(o.isMesh){
            pickMeshes.push(o);
            const mats=Array.isArray(o.material)?o.material:[o.material];
            mats.forEach(m=>{if(m){m.transparent=true;m.opacity=1;m.depthWrite=true;m.needsUpdate=true;}});
        }
    });
    scene.add(currentModel);
    dropHint.style.display="none";
    selected.clear();
    partsInfo=null;
    explodeState=false;
    explodeBtn.textContent="Explode";
}

function clearModel(){
    if(!currentModel) return;
    scene.remove(currentModel);
    currentModel.traverse(o=>{
        if(o.isMesh){
            o.geometry?.dispose();
            if(o.material?.isMaterial) o.material.dispose();
            if(Array.isArray(o.material)) o.material.forEach(m=>m.dispose());
        }
    });
    currentModel=null;
    pickMeshes.length=0;
    selected.clear();
    partsInfo=null;
    dropHint.style.display="";
    setStatus("Сцена очищена");
}

function fitView(){
    if(!currentModel) return;
    const box=new THREE.Box3().setFromObject(currentModel);
    const size=box.getSize(new THREE.Vector3());
    const center=box.getCenter(new THREE.Vector3());
    const maxDim=Math.max(size.x,size.y,size.z)||1;
    const dist=maxDim*1.8;
    camera.near=Math.max(0.01,maxDim/1000);
    camera.far=maxDim*100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    camera.position.copy(center.clone().add(new THREE.Vector3(dist,dist,dist)));
    controls.update();
}

function onPointerDown(e){
    if(!currentModel||pickMeshes.length===0) return;
    const rect=renderer.domElement.getBoundingClientRect();
    mouse.x=((e.clientX-rect.left)/rect.width)*2-1;
    mouse.y=-((e.clientY-rect.top)/rect.height)*2+1;
    raycaster.setFromCamera(mouse,camera);
    const inter=raycaster.intersectObjects(pickMeshes,true)[0];
    if(!inter) return;
    const mesh=inter.object;
    if(e.ctrlKey||e.metaKey){
        toggleSelect(mesh);
    }else{
        clearSelection();
        toggleSelect(mesh,true);
    }
    applyOpacityToSelection();
    render();
}

function toggleSelect(mesh,forceAdd=false){
    if(selected.has(mesh) && !forceAdd){
        deselect(mesh);
        selected.delete(mesh);
    }else{
        select(mesh);
        selected.add(mesh);
    }
}

function select(mesh){
    if(mesh.userData.__sel) return;
    const mats=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    const orig=mats.map(m=>m?.emissive?.getHex?.()??0x000000);
    mesh.userData.__sel={orig};
    mats.forEach(m=>{if(m&&m.emissive){m.emissive.setHex(0x5ab6ff);}});
}

function deselect(mesh){
    if(!mesh.userData.__sel) return;
    const mats=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    const orig=mesh.userData.__sel.orig;
    mats.forEach((m,i)=>{if(m&&m.emissive){m.emissive.setHex(orig[i]??0x000000);}});
    delete mesh.userData.__sel;
}

function clearSelection(){
    selected.forEach(m=>deselect(m));
    selected.clear();
}

function applyOpacityToSelection(){
    const val=parseFloat(opacityRange.value);
    if(selected.size===0) return;
    selected.forEach(m=>{
        const mats=Array.isArray(m.material)?m.material:[m.material];
        mats.forEach(mat=>{
            if(!mat) return;
            mat.opacity=val;
            mat.depthWrite=val>=1;
        });
    });
}

function buildPartsInfo(){
    if(!currentModel) return null;
    const center=new THREE.Box3().setFromObject(currentModel).getCenter(new THREE.Vector3());
    const roots=currentModel.children.filter(c=>c.visible);
    return roots.map((obj,i)=>{
        const bb=new THREE.Box3().setFromObject(obj);
        const cc=bb.getCenter(new THREE.Vector3());
        const dir=cc.clone().sub(center).normalize();
        const base=obj.position.clone();
        return {obj,dir,base,mag:0.22*(i+1)};
    });
}

function toggleExplode(){
    if(!currentModel) return;
    if(!partsInfo) partsInfo=buildPartsInfo();
    const k=explodeState?0:1;
    for(let i=0;i<partsInfo.length;i++){
        const p=partsInfo[i];
        p.obj.position.copy(p.base).addScaledVector(p.dir,k*p.mag);
    }
    explodeState=!explodeState;
    explodeBtn.textContent=explodeState?"Explode: on":"Explode";
    render();
}

function setStatus(msg){statusEl.textContent=msg;}

function resize(){
    const w=stage.clientWidth||stage.offsetWidth||1;
    const h=stage.clientHeight||stage.offsetHeight||1;
    renderer.setSize(w,h,false);
    camera.aspect=w/h;
    camera.updateProjectionMatrix();
}

let resizeTimer=null;
function onResizeThrottled(){
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{resize();render();},70);
}

function render(){
    renderer.render(scene,camera);
}
