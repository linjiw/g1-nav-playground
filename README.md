# G1 Nav Playground

Explore our learned flow-matching whole-body planner on a simulated Unitree G1. The model generates candidate
pelvis and joint motions from recent robot state, an obstacle elevation map, and a local goal. A geometric route
supplies that goal; a geometric selector chooses a candidate; NVIDIA's SONIC tracker executes it in MuJoCo.

This edition isolates learned motion generation: gradient guidance, fixed arm postures, forced shoulder-gate turns,
clip retrieval, leg IK, execution-model checking, and pose refinement are disabled. Routing, clearance-based selection,
coordinate conversion, joint limits, and SONIC remain separate components. It is not an end-to-end learned controller.

All eight original scenes and twelve goals use the same selected checkpoint and settings. There is one fixed-seed
attempt per goal, with failed attempts included. Each recording reports its actual outcome and final goal distance.
See [the model card](MODEL_CARD.md) for checkpoint selection, the comparison's limits, and all outcomes;
[data/planner.json](data/planner.json) binds the recordings to checkpoint and file hashes.

The browser replays recorded physics and plans; it does not perform model inference. Simulation pauses during CPU
planning, so 1× playback is simulated time, not a real-time deployment measurement. Pick a scene and an amber goal ring.

This repository contains the viewer and generated simulation recordings, without model weights, raw training data,
or inference code. The research runner retains the effective configuration and source hashes locally.

Credits: Unitree G1 model © Unitree Robotics (BSD-3-Clause, `licenses/unitree-BSD-3-Clause.txt`; meshes simplified).
SONIC © NVIDIA (NVIDIA Open Model License; used during recording). three.js (MIT, `vendor/three/LICENSE`).
Icons: Lucide (ISC). This is a simulation.

## Development checks

The page stays buildless; Node dependencies are only for regression tests. Use Node 22+.

```sh
npm ci
npm test
python3 -m http.server 8672 --bind 127.0.0.1
```

With that server running, in another terminal:

```sh
CHROME=/path/to/chrome npm run test:browser
```

`CHROME` defaults to `/opt/google/chrome/chrome`. `SITE` can override the default test URL,
`http://127.0.0.1:8672`. The browser suite checks every recorded plan transition, delayed and failed downloads,
reset/scrub/keyboard controls, a full replay, repeated scene changes, paused rendering, startup recovery, and a touch
viewport. Results and desktop/phone screenshots are written to the ignored `test-results/` directory.

The regression checks verify recording provenance and outcomes, including failure cases. The viewer refuses recordings that do not match this edition.

Edition query versions on scripts, styles, and recording requests isolate this release from previously cached assisted runs. Bump those versions together when publishing a new edition.
