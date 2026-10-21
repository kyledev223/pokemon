import * as THREE from 'three';

// The two throwables. The pink "puff orb" is a candy sphere wrapped in a tilted cream ring
// with a gold four-point star stud; the golden ball is a shiny gold sphere with the same star.
// Both are built at radius 1 and scaled by the caller.

export const PINK = '#ff5ea8';
export const GOLD = '#ffc928';
export const INK = '#2a2140';

function starShape(outer: number, inner: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 ? inner : outer;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

export const STAR_GEO = new THREE.ExtrudeGeometry(starShape(1, 0.3), { depth: 0.25, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1 });
STAR_GEO.center();

const SPHERE_GEO = new THREE.IcosahedronGeometry(1, 2);
const RING_GEO = new THREE.TorusGeometry(1.32, 0.13, 6, 28);
const OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });

export const PINK_MAT = new THREE.MeshStandardMaterial({ color: PINK, roughness: 0.45, metalness: 0.05, emissive: PINK, emissiveIntensity: 0.12, flatShading: true });
export const GOLD_MAT = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.25, metalness: 0.55, emissive: '#ffb300', emissiveIntensity: 0.35, flatShading: true });
const RING_MAT = new THREE.MeshStandardMaterial({ color: '#fff3d6', roughness: 0.6, flatShading: true });
const STAR_MAT = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.3, metalness: 0.4, emissive: '#ffb300', emissiveIntensity: 0.3, flatShading: true });
const WHITE_STAR_MAT = new THREE.MeshStandardMaterial({ color: '#fffbe8', roughness: 0.4, emissive: '#ffffff', emissiveIntensity: 0.4, flatShading: true });

/** Ink inverted-hull outline so 3D props match the bordered UI. */
export function outline(mesh: THREE.Mesh, thickness = 0.06): THREE.Mesh {
  const o = new THREE.Mesh(mesh.geometry, OUTLINE_MAT);
  o.scale.setScalar(1 + thickness);
  mesh.add(o);
  return o;
}

export function makePinkOrb(withOutline = false): THREE.Group {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(SPHERE_GEO, PINK_MAT);
  if (withOutline) outline(ball, 0.05);
  const ring = new THREE.Mesh(RING_GEO, RING_MAT);
  ring.rotation.set(Math.PI / 2 - 0.35, 0, 0.42);
  if (withOutline) outline(ring, 0.12);
  const star = new THREE.Mesh(STAR_GEO, STAR_MAT);
  star.scale.setScalar(0.42);
  star.position.set(0, 0.42, 0.93);
  star.rotation.x = -0.42;
  g.add(ball, ring, star);
  return g;
}

export function makeGoldBall(withOutline = false): THREE.Group {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(SPHERE_GEO, GOLD_MAT);
  if (withOutline) outline(ball, 0.05);
  const star = new THREE.Mesh(STAR_GEO, WHITE_STAR_MAT);
  star.scale.setScalar(0.4);
  star.position.set(0, 0.25, 0.97);
  star.rotation.x = -0.25;
  g.add(ball, star);
  return g;
}

/** Soft four-point sparkle used for catch bursts. */
let sparkleTex: THREE.Texture | null = null;
export function sparkleTexture(): THREE.Texture {
  if (sparkleTex) return sparkleTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.translate(32, 32);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = i % 2 ? 7 : 30;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  sparkleTex = new THREE.CanvasTexture(c);
  return sparkleTex;
}

/** Tall glowing light beam that fades upward; one geometry/material shared by every golden ball. */
export const BEAM_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.32, 0.5, 46, 10, 1, true);
  g.translate(0, 23, 0);
  return g;
})();
export const BEAM_MAT = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
  uniforms: { color: { value: new THREE.Color('#ffd23f') }, time: { value: 0 } },
  vertexShader: `
    #include <common>
    varying float vH;
    varying float vDist;
    void main() {
      vH = uv.y;
      vec4 p = vec4(position, 1.0);
      #ifdef USE_INSTANCING
        p = instanceMatrix * p;
      #endif
      vec4 mv = modelViewMatrix * p;
      vDist = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3 color;
    uniform float time;
    varying float vH;
    varying float vDist;
    void main() {
      // Fade out when you're standing right next to a beam so it doesn't wash out the view.
      float a = pow(1.0 - vH, 1.6) * (0.55 + 0.1 * sin(time * 3.0 + vH * 20.0)) * smoothstep(1.5, 12.0, vDist);
      gl_FragColor = vec4(color, a);
    }`,
});
