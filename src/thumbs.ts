import * as THREE from 'three';
import { speciesById } from '../shared/species';
import { buildCritter } from './game/critterMesh';

// Renders each species once to a small PNG for the dex, market and arena UIs.

const cache = new Map<string, string>();
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
const SILHOUETTE = new THREE.MeshBasicMaterial({ color: '#2a2140' });

function setup(): boolean {
  if (renderer) return true;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return false;
  }
  renderer.setSize(160, 160, false);
  renderer.setPixelRatio(1);
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#ffd9b0', 2.2));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  return true;
}

/** PNG data URL of a species. `silhouette` renders it as a flat dark shape for uncaught dex slots. */
export function thumb(speciesId: number, opts: { silhouette?: boolean } = {}): string {
  const key = `${speciesId}:${opts.silhouette ? 's' : 'c'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!setup()) return '/favicon.svg';
  const s = speciesById(speciesId);
  const rig = buildCritter(s);
  rig.group.scale.setScalar(1);
  rig.group.rotation.y = -0.5;
  if (opts.silhouette) scene.overrideMaterial = SILHOUETTE;
  scene.add(rig.group);
  camera.position.set(0, 0.75, 3.1);
  camera.lookAt(0, 0.5, 0);
  renderer!.render(scene, camera);
  const url = renderer!.domElement.toDataURL('image/png');
  scene.remove(rig.group);
  scene.overrideMaterial = null;
  cache.set(key, url);
  return url;
}
