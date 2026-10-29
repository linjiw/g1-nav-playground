# G1 Nav Playground

A simulated Unitree G1 walks to a goal through obstacles. A flow-matching whole-body planner picks the way (routing,
ducking under bars, tucking the arms, turning sideways through gaps) and NVIDIA's SONIC tracker walks it in MuJoCo.

Every run here was recorded from the real planner and SONIC; the page replays each tick and plan as it happened. Pick a playground, then click an amber ring to watch the robot walk to it.

This repository is the page only: no model weights and no planner code. Built on 2026-10-29.

Credits: Unitree G1 model © Unitree Robotics (BSD-3-Clause, `licenses/unitree-BSD-3-Clause.txt`; meshes simplified).
SONIC © NVIDIA (NVIDIA Open Model License; it runs on the server only). three.js (MIT, `vendor/three/LICENSE`).
Icons: Lucide (ISC). It is a simulation; nothing here drives a real robot.
