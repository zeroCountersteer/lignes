import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";
import initOCCT, { readStepFile } from "https://cdn.jsdelivr.net/npm/occt-import-js@1.1.1/dist/occt-import-js.esm.js";

const stage = document.getElementById("stage");
const fileInput = document.getElementById("fileInput");
const loadRepoBtn = document.getElementById("loadRepoBtn");
const fitBtn = document.getElementById("fitBtn");
const explodeBtn = document.getElementById("explodeBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const wrap = document.getElementById("stageWrap");

let renderer, scene, camera, controls;
let occt = null;
let currentModel = null;
let exploded = false;

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

    const hemi = new THREE.HemisphereLight(0xffffff,0x202025,0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff,1.0);
    dir.position.set(500,800,600);
    scene.add(dir);

    resize();
    window.addEventListener("resize", resize);
    animate();

    setStatus("Загрузка ядра импорта…");
    occt = await initOCCT({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/occt-import-js@1.1.1/dist/${file}`
    });
    setStatus("Готово. Загрузите файл или нажмите «Открыть models/model.step».");

    wireUI();
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
        }catch(err){
            setStatus("Ошибка: " + err.message);
        }
    });

    fitBtn.addEventListener("click", fitView);
    explodeBtn.addEventListener("click", toggleExplode);
    clearBtn.addEventListener("click", clearModel);

    ["dragenter","dragover"].forEach(t=>{
        stage.addEventListener(t,e=>{
            e.preventDefault();
            wrap.classList.add("dragover");
        });
    });
    ["dragleave","drop"].forEach(t=>{
        stage.addEventListener(t,e=>{
            e.preventDefault();
            wrap.classList.remove("dragover");
        });
    });
    stage.addEventListener("drop",async e=>{
        const f = e.dataTransfer?.files?.[0];
        if(!f) return;
        const buf = await f.arrayBuffer();
        await loadStepFromBuffer(buf,f.name);
    });
}

async function loadStepFromBuffer(buf, name){
    if(!occt){
        setStatus("Импортёр не инициализирован.");
        return;
    }
    try{
        setStatus("Импорт STEP: " + name);
        // Импортируем и тесселируем через occt-import-js
        const result = readStepFile(occt, new Uint8Array(buf), {
            // density: 0.6 — можно добавить параметры тесселяции при желании
        });

        // result содержит массивы поверхностей/тел; строим three.js меши
        const group = new THREE.Group();
        for(const solid of result.meshes){
            const geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.Float32BufferAttribute(solid.attributes.position.array, 3));
            if (solid.index) {
                geom.setIndex(Array.from(solid.index.array));
            }
            geom.computeVertexNormals();

            const mat = new THREE.MeshStandardMaterial({
                metalness: 0.05,
                roughness: 0.85,
                color: 0xbfc7d5
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            group.add(mesh);
        }

        setModel(group);
        fitView();
        setStatus("Готово: " + name + ` (полигонов: ${countTriangles(group)})`);
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
    const parts = currentModel.children;
    const k = exploded ? 0 : 1;
    parts.forEach((c,i)=>{
        const b = new THREE.Box3().setFromObject(c);
        const cc = b.getCenter(new THREE.Vector3());
        const dir = cc.clone().sub(center).normalize();
        const mag = 0.15*(i+1);
        c.position.copy(dir.multiplyScalar(k*mag));
    });
    exploded = !exploded;
    explodeBtn.textContent = exploded ? "Explode: on" : "Explode";
}

function countTriangles(group){
    let tri = 0;
    group.traverse(o=>{
        if(o.isMesh && o.geometry?.index){
            tri += o.geometry.index.count/3|0;
        }else if(o.isMesh && o.geometry?.attributes?.position){
            tri += (o.geometry.attributes.position.count/3)|0;
        }
    });
    return tri;
}

function setStatus(msg){ statusEl.textContent = msg; }

function resize(){
    const w = stage.clientWidth || stage.offsetWidth;
    const h = stage.clientHeight || stage.offsetHeight || 1;
    if(renderer){
        renderer.setSize(w,h,false);
    }
    if(camera){
        camera.aspect = w/h;
        camera.updateProjectionMatrix();
    }
}

function animate(){
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene,camera);
}
