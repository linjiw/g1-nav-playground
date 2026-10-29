# Flow whole-body planner — learned-generator edition

This demo presents the learned motion generator from our latest adopted planner family, with motion-shaping helpers
disabled. It records a simulated Unitree G1 executing model-generated references through NVIDIA SONIC in MuJoCo.
The public release contains generated simulation recordings and the viewer; model weights and training data stay local.

## What is learned

The flow-matching network learns from motion examples paired with obstacle scenes, including generated scenes built
around motion examples. Given recent robot poses, an obstacle elevation map, and a nearby navigation goal, it transforms
random noise into a short whole-body trajectory. Outputs describe pelvis motion and 29 joint positions and velocities.

The network has 9,435,137 parameters. Each replan initially samples 16 candidates with ten flow integration steps and
two consecutive motion chunks, covering one second. Replanning occurs every 0.16 seconds of simulated time. If the
first pool misses the clearance margin, the same network samples 48 more goal-conditioned candidates and, if necessary,
16 stop-conditioned candidates. The displayed candidate count includes those extra pools.

## What is separate from the network

| Component | This edition |
|---|---|
| Nearby navigation goals | Geometric routing on known simulated obstacle geometry |
| Candidate choice | Geometric clearance and progress ranking |
| Tracking and dynamics | Frozen SONIC tracker and MuJoCo physics |
| Coordinate convention and joint limits | Datum conversion, rotations, and joint-limit clamping |
| Collision-gradient guidance | Disabled |
| Fixed arm postures and passage-specific settings | Disabled |
| Forced sideways shoulder-gate heading | Disabled |
| Retrieved motion clips and clip commitment | Disabled |
| Leg inverse kinematics | Disabled |
| Execution-model checking and pose refinement | Disabled |

Every navigation replan was checked during recording: its joint positions equal the selected network candidate before
tracker conversion. The surrounding route and selector remain algorithms. This is not an end-to-end learned controller.

Clearance checks operate on planned geometry, with an obstacle buffer. A passing candidate can still contact an
obstacle during physical tracking. If all candidates fail the margin, the selector can issue the candidate with the
most clearance even though it does not meet the margin; the UI labels this as a fallback, not a safe stop.

## Selection protocol and limits

We compared the three independent training checkpoints in the adopted generator family on four original demo tasks:
empty floor, low bar, narrow corridor, and shoulder gate. Each used the same configuration, episode seed 1, noise stream,
and one attempt per goal. Selection was registered before rollout: most clean final arrivals, then fewest falls, fewest
contact runs, smallest sum of final goal distance divided by initial distance, then lowest checkpoint number.

The selected checkpoint is used unchanged for all twelve goals across eight scenes. Four recordings come from that
checkpoint's selection panel; the other eight goals are recorded once and do not enter the selection score. Scene geometry and goals are unchanged.
The model card includes every screen outcome and every selected-model outcome, including failures.

This is a small descriptive comparison on demonstration tasks, not a held-out benchmark. It identifies the best result
under this protocol among these three checkpoints, rather than establishing a universally best learned policy. Reported
success rates of the complete assisted research system do not apply to this edition. Failures can come from the
generated proposals, routing or selection, or physical tracking. Removing several helpers together does not isolate
the cause of an individual failure.

## Recording and outcome definitions

- Each run starts from a stand and receives its goal after 0.5 seconds.
- Runs end after 30 seconds of attempted navigation, a fall, one second after first obstacle contact, or 1.5 seconds
  after entering hold mode.
- A clean arrival enters and finishes within 0.4 m of the goal, ends in hold mode, and has no obstacle contact or fall.
- Obstacle contact means measured obstacle force above 5 N. A fall is detected from pelvis height below 0.38 m, tilt
  above 0.8 radians, or a simulator reset.
- Entering the goal region is an event, not the final outcome. A robot that subsequently leaves it is labeled separately.
- No success-only retries or replacement by older assisted recordings are used.

The browser replays recorded frames and plans. CPU inference ran with simulation paused, so the replay speed is
simulated time and does not establish real-time deployment performance. Joint limits and tracking can change execution
from the displayed reference. These results concern simulation only.

The effective settings, source hashes, and completed recording receipts are retained with the local research runner.
The public [manifest](data/planner.json) records checkpoint identity, comparison results, and recording hashes.

For rendering, candidate path lines are sampled every 0.08 seconds, retaining both endpoints and every candidate.
The selected plan and executed robot frames retain their 50 Hz time resolution; chosen-plan positions/joints are
rounded to millimeter/milliradian precision for display. Touch devices cache at most two recordings, desktop four.

## Checkpoint comparison and selected model

Selected: **checkpoint 0**, SHA-256 `8acafde328febffe0127fba8832a7a24dc76d01852bfaf0a3eb1dedc88d028ab`.

All three checkpoints reached one of four screen goals cleanly. Checkpoint 0 won the registered contact-count tie-break. This supports its use for this demo; it does not show a higher goal-completion rate than the other two.

| Checkpoint | Empty floor | Low bar | Corridor | Shoulder gate | Contact runs | Falls |
|---|---|---|---|---|---:|---:|
| 0 | Clean arrival | Time limit | Time limit | Time limit | 0 | 0 |
| 1 | Clean arrival | Time limit | Contact | Time limit | 1 | 0 |
| 2 | Clean arrival | Contact | Contact | Time limit | 2 | 0 |

## All published recordings

**8 clean arrivals, 4 time limits, 0 contact runs, 0 falls.** These are the twelve demonstration attempts, not a general success-rate estimate. The four unsuccessful recordings remain selectable.

| Scene / goal | Goal (m) | Outcome | Final distance (m) |
|---|---|---|---:|
| clutter-0 | (8.6, 0) | Clean arrival | 0.136 |
| clutter-1 | (6.4, 2.6) | Clean arrival | 0.188 |
| corridor-0 | (6, 0) | Time limit | 5.096 |
| course-0 | (13.2, 0) | Time limit | 10.575 |
| empty-0 | (4, 0) | Clean arrival | 0.162 |
| empty-1 | (1.5, 3) | Clean arrival | 0.175 |
| gate-0 | (4.6, 0) | Time limit | 3.480 |
| lowbar-0 | (5.2, 0) | Time limit | 3.568 |
| open-0 | (6, 2) | Clean arrival | 0.134 |
| open-1 | (5.4, -2.6) | Clean arrival | 0.030 |
| open-2 | (-2.6, 0.6) | Clean arrival | 0.283 |
| slalom-0 | (7.4, 0) | Clean arrival | 0.177 |

The shoulder gate does not produce a successful learned sideways passage in this edition. The Course run also stops before its goal; its failure is visible in playback rather than replaced with an assisted trajectory.
