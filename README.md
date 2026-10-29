# G1 Nav Playground

A simulated Unitree G1 walks to a goal through obstacles. A flow-matching whole-body planner picks the way (routing,
ducking under bars, tucking the arms, turning sideways through gaps) and NVIDIA's SONIC tracker walks it in MuJoCo.

Every run here was recorded from the real planner and SONIC; the page replays each tick and plan as it happened. Pick a playground, then click an amber ring to watch the robot walk to it.

This repository is the page only: no model weights and no planner code. Built on 2026-10-29.

Credits: Unitree G1 model © Unitree Robotics (BSD-3-Clause, `licenses/unitree-BSD-3-Clause.txt`; meshes simplified).
SONIC © NVIDIA (NVIDIA Open Model License; it runs on the server only). three.js (MIT, `vendor/three/LICENSE`).
Icons: Lucide (ISC). It is a simulation; nothing here drives a real robot.

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

Recorded trajectories are preserved. All 12 bundled runs report zero obstacle-contact events and no falls. Course
reaches its goal during the run but finishes 0.429 m from it, just beyond the 0.4 m arrival radius; the status reports
“Stopped near the goal” in that case. Predicted ghost poses are optional overlays, distinct from the solid robot.
