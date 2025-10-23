import * as THREE from "three";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";

const stage = document.getElementById("stage");
const fileInput = document.getElementById("fileInput");
const loadRepoBtn = document.getElementById("loadRepoBtn");
const fitBtn = document.getElementById("fitBtn");
const explodeBtn = document.getElementById("explodeBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const wrap = document.getElementById("stageWrap");

let renderer, scene, camera, controls;
let occt = null, readStepFile = null;
let currentModel = null, exploded = false;

init().catch(e => setStatus("Ошибка инициализации: " + (e?.message || e)));

async function init(){
    renderer = new THREE.WebGLRenderer({antialias:true,alpha:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    stage.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c0f14);

    camera = new THREE.PerspectiveCamera(45,1,0.1,5000);
    camera.position.set(250,220,260);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;

    scene.add(new THREE.HemisphereLight(0xffffff,0x202025,0.9));
    const dir = new THREE.DirectionalLight(0xffffff,1.0);
    dir.position.set(500,800,600);
    scene.add(dir);

    resize();
    window.addEventListener("resize", resize);
    animate();

    setStatus("Загрузка ядра импорта…");
    await loadOCCT();               // <-- динамический подбор URL
    setStatus("Готово. Загрузите файл или нажмите «Открыть models/model.step».");
    wireUI();
}

async function loadOCCT(){
    // ВАЖНО: ссылки должны быть на jsDelivr/unpkg, без подмены на isdelivr
    const candidates = [
        // jsDelivr
        "https://cdn.jsdelivr.net/npm/occt-import-js/occt-import-js.esm.js",
        "https://cdn.jsdelivr.net/npm/occt-import-js/dist/occt-import-js.esm.js",
        "https://cdn.jsdelivr.net/npm/occt-import-js/lib/occt-import-js.esm.js",
        // unpkg бэкап
        "https://unpkg.com/occt-import-js/occt-import-js.esm.js",
        "https://unpkg.com/occt-import-js/dist/occt-import-js.esm.js",
        "https://unpkg.com/occt-import-js/lib/occt-import-js.esm.js"
    ];

    let mod, base = null;
    let lastErr = null;
    for(const url of candidates){
        try{
            mod = await import(/* @vite-ignore */ url);
            base = url.substring(0, url.lastIndexOf("/") + 1); // каталог с .esm.js
            if (mod?.default && mod?.readStepFile) { break; }
        }catch(e){ lastErr = e; }
    }
    if(!mod) throw new Error("Не удалось загрузить occt-import-js. Проверь блокировщики/CORS. Последняя ошибка: " + (lastErr?.message||lastErr));

    // Инициализация с корректным locateFile для WASM рядом с модулем
    occt = await mod.default({
        locateFile: (file) => base + file
    });
    readStepFile = mod.readStepFile;
}

function wireUI(){
    fileInput.addEventListener("change", async e=>{
        const f = e.target.files?.[0];
        if(!f) return;
        const buf = await f.arrayBuffer();
        await loadStepFromBuffer(buf, f.name);
    });

    loadRepoBtn.addEventListener("click", async ()=>{
        try{
            setStatus("Загрузка models/model.step …");
            const res = await fetch("models/model.step",{cache:"no-store"});
            if(!res.ok) throw new Error("Файл не найден (models/model.step)");
            const buf = await res.arrayBuffer();
            await loadStepFromBuffer(buf,"model.step");
        }catch(err){ setStatus("Ошибка: " + err.message); }
    });

    ["dragenter","dragover"].forEach(t=>{
        stage.addEventListener(t,e=>{ e.preventDefault(); wrap.classList.add("dragover"); });
    });
    ["dragleave","drop"].forEach(t=>{
        stage.addEventListener(t,e=>{ e.preventDefault(); wrap.classList.remove("dragover"); });
    });
    stage.addEventListener("drop", async e=>{
        const f = e.dataTransfer?.files?.[0];
        if(!f) return;
        const buf = await f.arrayBuffer();
        await loadStepFromBuffer(buf,f.name);
    });

    fitBtn.addEventListener("click", fitView);
    explodeBtn.addEventListener("click", toggleExplode);
    clearBtn.addEventListener("click", clearModel);
}

async function loadStepFromBuffer(buf, name){
    if(!occt || !readStepFile){ setStatus("Импортёр не инициализирован."); return; }
    try{
        setStatus("Импорт STEP: " + name);
        const result = readStepFile(occt, new Uint8Array(buf), {});
        const group = new THREE.Group();
        for(const solid of result.meshes){
            const geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.Float32BufferAttribute(solid.attributes.position.array, 3));
            if (solid.index) geom.setIndex(Array.from(solid.index.array));
            geom.computeVertexNormals();
            group.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ metalness:0.05, roughness:0.85, color:0xbfc7d5 })));
        }
        setModel(group);
        fitView();
        setStatus("Готово: " + name + " (полигонов: " + countTriangles(group) + ")");
    }catch(err){
        console.error(err);
        setStatus("Ошибка импорта: " + (err?.message || err));
    }
}

function setModel(group){
    clearModel();
    currentModel = group;
    scene.add(currentModel);
    exploded = false;
    explodeBtn.textContent = "Explode";
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
    currentModel = null;
    setStatus("Сцена очищена");
}

function fitView(){
    if(!currentModel) return;
    const box = new THREE.Box3().setFromObject(currentModel);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x,size.y,size.z) || 1;
    const dist = maxDim * 2.2;
    camera.near = maxDim/1000;
    camera.far = maxDim*100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    camera.position.copy(center.clone().add(new THREE.Vector3(dist, dist, dist)));
    controls.update();
}

function toggleExplode(){
    if(!currentModel) return;
    const box = new THREE.Box3().setFromObject(currentModel);
    const center = box.getCenter(new THREE.Vector3());
    const k = exploded ? 0 : 1;
    currentModel.children.forEach((c,i)=>{
        const b = new THREE.Box3().setFromObject(c);
        const cc = b.getCenter(new THREE.Vector3());
        const dir = cc.clone().sub(center).normalize();
        c.position.copy(dir.multiplyScalar(k * 0.15 * (i+1)));
    });
    exploded = !exploded;
    explodeBtn.textContent = exploded ? "Explode: on" : "Explode";
}

function countTriangles(group){
    let tri = 0;
    group.traverse(o=>{
        if(o.isMesh && o.geometry?.index) tri += o.geometry.index.count/3|0;
        else if(o.isMesh && o.geometry?.attributes?.position) tri += (o.geometry.attributes.position.count/3)|0;
    });
        return tri;
}

function setStatus(msg){ statusEl.textContent = msg; }

function resize(){
    const w = stage.clientWidth||stage.offsetWidth||1;
    const h = stage.clientHeight||stage.offsetHeight||1;
    renderer.setSize(w,h,false);
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
}

function animate(){
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene,camera);
}
