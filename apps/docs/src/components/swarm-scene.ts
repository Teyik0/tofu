import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  DirectionalLight,
  EdgesGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";

export function createSwarmScene(element: HTMLDivElement, onUnavailable: () => void): () => void {
  const renderer = new WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(0, 0);
  element.append(renderer.domElement);
  const scene = new Scene();
  const camera = new PerspectiveCamera(36, 1, 0.1, 40);
  camera.position.set(4.5, 3.2, 6.5);
  camera.lookAt(0, 0, 0);
  const assembly = new Group();
  scene.add(assembly);
  scene.add(new AmbientLight(0xff_fb_ed, 2.8));
  const light = new DirectionalLight(0xff_fb_ed, 4);
  light.position.set(-3, 5, 4);
  scene.add(light);

  const cubeGeometry = new BoxGeometry(1.65, 1.65, 1.65);
  const cubeMaterial = new MeshStandardMaterial({ color: 0xe7_e9_c4, roughness: 0.92 });
  const cube = new Mesh(cubeGeometry, cubeMaterial);
  cube.rotation.set(0.08, 0.15, -0.06);
  assembly.add(cube);
  const edgeGeometry = new EdgesGeometry(cubeGeometry);
  const edgeMaterial = new LineBasicMaterial({
    color: 0x52_64_40,
    opacity: 0.24,
    transparent: true,
  });
  cube.add(new LineSegments(edgeGeometry, edgeMaterial));

  const poreGeometry = new SphereGeometry(0.025, 6, 4);
  const poreMaterial = new MeshStandardMaterial({ color: 0xa6_b1_8a, roughness: 1 });
  for (let index = 0; index < 32; index += 1) {
    const pore = new Mesh(poreGeometry, poreMaterial);
    const x = Math.sin(index * 17.31) * 0.66;
    const y = Math.cos(index * 8.19) * 0.65;
    pore.position.set(x, y, 0.826);
    pore.scale.setScalar(0.55 + (index % 4) * 0.2);
    cube.add(pore);
  }
  const peerGeometry = new BoxGeometry(0.14, 0.14, 0.14);
  const peerMaterial = new MeshStandardMaterial({ color: 0x69_76_4b, roughness: 0.8 });
  const orbitMaterial = new LineBasicMaterial({
    color: 0x88_94_71,
    opacity: 0.32,
    transparent: true,
  });
  const orbitGeometries: BufferGeometry[] = [];
  const peers: { mesh: Mesh; ring: number; phase: number }[] = [];
  for (let ring = 0; ring < 3; ring += 1) {
    const orbit = new Group();
    orbit.rotation.set(0.3 + ring * 0.45, ring * 0.7, -0.35 + ring * 0.4);
    const radius = 2.1 + ring * 0.2;
    const points = Array.from({ length: 97 }, (_, index) => {
      const angle = (index / 96) * Math.PI * 2;
      return new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    });
    const geometry = new BufferGeometry().setFromPoints(points);
    orbitGeometries.push(geometry);
    orbit.add(new Line(geometry, orbitMaterial));
    for (let index = 0; index < 3; index += 1) {
      const mesh = new Mesh(peerGeometry, peerMaterial);
      peers.push({ mesh, phase: (index / 3) * Math.PI * 2 + ring, ring });
      orbit.add(mesh);
    }
    assembly.add(orbit);
  }

  let visible = false;
  let stopped = false;
  let frame = 0;
  let lastFrame = 0;
  let elapsed = 0;
  const render = (time: number) => {
    frame = 0;
    if (stopped || !visible || document.hidden) {
      return;
    }
    if (time - lastFrame >= 1000 / 30) {
      elapsed += Math.min((time - lastFrame) / 1000, 0.05);
      lastFrame = time;
      cube.rotation.y = 0.15 + Math.sin(elapsed * 0.2) * 0.12;
      assembly.position.y = Math.sin(elapsed * 0.5) * 0.07;
      for (const peer of peers) {
        const radius = 2.1 + peer.ring * 0.2;
        const angle = peer.phase + elapsed * (0.13 + peer.ring * 0.03);
        peer.mesh.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
        peer.mesh.rotation.set(angle, angle * 0.5, angle);
      }
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(render);
  };
  const resume = () => {
    if (visible && !document.hidden && !stopped && !frame) {
      lastFrame = performance.now();
      frame = requestAnimationFrame(render);
    }
  };
  const resize = new ResizeObserver(() => {
    const { width, height } = element.getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    resume();
  });
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    resume();
  });
  const contextLost = (event: Event) => {
    event.preventDefault();
    dispose();
    onUnavailable();
  };
  const dispose = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    intersection.disconnect();
    document.removeEventListener("visibilitychange", resume);
    renderer.domElement.removeEventListener("webglcontextlost", contextLost);
    for (const geometry of [
      cubeGeometry,
      edgeGeometry,
      poreGeometry,
      peerGeometry,
      ...orbitGeometries,
    ]) {
      geometry.dispose();
    }
    for (const material of [
      cubeMaterial,
      edgeMaterial,
      poreMaterial,
      peerMaterial,
      orbitMaterial,
    ]) {
      material.dispose();
    }
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  resize.observe(element);
  intersection.observe(element);
  document.addEventListener("visibilitychange", resume);
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  return dispose;
}
