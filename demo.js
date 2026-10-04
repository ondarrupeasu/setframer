// Built-in demo studio: a small news set made from primitives, so students (and tests) can try the
// whole flow without downloading anything. Two monitors with real screen meshes, a desk in front.
import * as THREE from 'three';

export function buildDemoStudio() {
  const root = new THREE.Group();
  root.name = 'Demo studio';
  const std = (color, rough = 0.6, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const add = (geo, mat, name, x, y, z) => {
    const m = new THREE.Mesh(geo, mat); m.name = name; m.position.set(x, y, z); root.add(m); return m;
  };

  add(new THREE.BoxGeometry(14, 0.1, 10), std(0x2a2d36, 0.35), 'Floor', 0, -0.05, 0);
  add(new THREE.BoxGeometry(14, 4.5, 0.2), std(0x1b2a44, 0.8), 'BackWall', 0, 2.25, -4);
  add(new THREE.BoxGeometry(14, 0.12, 0.25), std(0xff5a4d, 0.4).clone(), 'LightStrip', 0, 3.6, -3.85)
    .material.emissive = new THREE.Color(0xff5a4d);
  for (const x of [-6.2, 6.2]) add(new THREE.BoxGeometry(0.6, 4.5, 0.6), std(0x30364a, 0.5, 0.2), 'Column', x, 2.25, -3.6);
  add(new THREE.CylinderGeometry(4.5, 4.5, 0.12, 64), std(0x3a3f4c, 0.25, 0.1), 'Riser', 0, 0.06, -0.6);

  // Monitors: bezel + a separate SCREEN mesh (what you tag as Screen A/B). UVs flipped to glTF's v-down.
  const screenGeo = () => {
    const g = new THREE.PlaneGeometry(2.4, 1.35);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    return g;
  };
  const screenMat = () => new THREE.MeshStandardMaterial({ color: 0x050608, roughness: 0.15, metalness: 0.0 });
  [[-2.6, 'Left'], [2.6, 'Right']].forEach(([x, side]) => {
    const g = new THREE.Group(); g.position.set(x, 2.3, -3.75); g.rotation.y = -x * 0.08;
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(2.55, 1.5, 0.08), std(0x111216, 0.4, 0.3)); bezel.name = `Monitor${side}_Bezel`;
    const scr = new THREE.Mesh(screenGeo(), screenMat()); scr.name = `Monitor${side}_Screen`; scr.position.z = 0.041;
    g.add(bezel, scr); root.add(g);
  });

  // Desk (in front of where the presenter stands → it must hide the presenter's legs)
  add(new THREE.BoxGeometry(2.6, 0.95, 0.8), std(0xe8e8ee, 0.3), 'Desk', 0, 0.6, 0.6);
  add(new THREE.BoxGeometry(2.8, 0.06, 0.95), std(0x15161b, 0.2, 0.4), 'DeskTop', 0, 1.1, 0.6);

  const key = new THREE.PointLight(0xffffff, 25, 0, 2); key.position.set(2, 4, 3); root.add(key);
  const fill = new THREE.PointLight(0x88aaff, 12, 0, 2); fill.position.set(-3, 3, 2); root.add(fill);
  return root;
}
