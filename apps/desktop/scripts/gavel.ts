// writes src/renderer/gavel/scene.generated.ts from the robot's art. run it after editing
// src/renderer/gavel/parts.txt or anim-parts.txt:  node scripts/gavel.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { generate, loadParts } from "./gavelScene.ts";

const file = path.join(import.meta.dirname, "../src/renderer/gavel/scene.generated.ts");
writeFileSync(file, generate(loadParts()));
console.log(file);
