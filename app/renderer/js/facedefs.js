// Names shared by the face tracker, the bind editor and the animation drives (no imports besides T, so hands.js can
// use them without a cycle).
import { T } from './core.js';

// face "gestures": expressions and head moves usable anywhere a hand pose can be picked (bindings, "only while")
//   id · emoji · label
export const faceExprList = () => [
  ['f:smile', '😊', T`ยิ้ม`], ['f:mouth', '😮', T`อ้าปาก`], ['f:brow', '🤨', T`ยักคิ้ว`], ['f:kiss', '😗', T`จู๋ปาก`], ['f:puff', '🐡', T`ทำแก้มป่อง`],
  ['f:eyes', '😑', T`หลับตาค้างไว้`], ['f:winkL', '😉', T`ขยิบตาซ้าย`], ['f:winkR', '😜', T`ขยิบตาขวา`],
  ['f:turnL', '👈', T`หันหน้าไปทางซ้ายของจอ`], ['f:turnR', '👉', T`หันหน้าไปทางขวาของจอ`], ['f:up', '⬆️', T`เงยหน้า`], ['f:down', '⬇️', T`ก้มหน้า`],
  ['f:tiltL', '↖️', T`เอียงหัวไปทางซ้ายของจอ`], ['f:tiltR', '↗️', T`เอียงหัวไปทางขวาของจอ`],
  ['f:cover', '🙈', T`เอามือปิดตา`], ['f:hush', '🤫', T`ชี้นิ้วแตะปาก`],
];
export const faceExprName = (id) => { const g = faceExprList().find((x) => x[0] === id); return g ? `${g[1]} ${g[2]}` : ''; };
export const faceExprEmoji = (id) => { const g = faceExprList().find((x) => x[0] === id); return g ? g[1] : ''; };

// where a layer can sit on the face   id · label · natural width as a share of the face width
export const FACE_PTS = () => [
  ['eyes', T`แว่น — ระหว่างตา`, 1.02], ['top', T`หมวก — เหนือหัว`, 1.25], ['forehead', T`หน้าผาก`, 0.55],
  ['eyeL', T`ตาซ้ายในจอ`, 0.32], ['eyeR', T`ตาขวาในจอ`, 0.32], ['nose', T`ปลายจมูก`, 0.3], ['under', T`หนวด — ใต้จมูก`, 0.55],
  ['mouth', T`ปาก`, 0.45], ['chin', T`คาง`, 0.5], ['cheekL', T`แก้มซ้ายในจอ`, 0.3], ['cheekR', T`แก้มขวาในจอ`, 0.3], ['face', T`ทั้งหน้า (หน้ากาก)`, 1.15],
];
// where on the face a hand gesture has to be made (bindings: "hand position")   id · label
export const FACE_ZONES = () => [
  ['', T`ที่ไหนก็ได้`], ['eyes', T`ใกล้ตา`], ['mouth', T`ใกล้ปาก`], ['ears', T`ข้างหู`], ['top', T`บนหัว`],
  ['cheeks', T`ที่แก้ม`], ['chin', T`ที่คาง`], ['face', T`ตรงหน้า`],
];
export const faceZoneName = (z) => { const f = FACE_ZONES().find((x) => x[0] === z); return f ? f[1] : ''; };
// the zone that suits a face sticker's spot (one-click "put on / take off with a gesture")
export const zoneOfPt = (pt) => ({ eyes: 'eyes', eyeL: 'eyes', eyeR: 'eyes', top: 'top', forehead: 'top', nose: 'mouth', under: 'mouth', mouth: 'mouth', chin: 'chin', cheekL: 'cheeks', cheekR: 'cheeks' }[pt] || 'face');
export const faceFit = (pt) => { const p = FACE_PTS().find((x) => x[0] === pt); return p ? p[2] : 0.5; };

// animation drives that read the face (anim-core DRIVES)
export const FACE_DRIVES = () => [
  ['fyaw', T`หน้า: หันซ้าย ↔ ขวา`], ['fpitch', T`หน้า: ก้ม ↕ เงย`], ['froll', T`หน้า: เอียงหัว`], ['fmouth', T`หน้า: อ้าปาก`], ['fsmile', T`หน้า: ยิ้ม`],
  ['fblink', T`หน้า: หลับตา`], ['fbrow', T`หน้า: ยักคิ้ว`], ['fx', T`หน้า: ตำแหน่ง ซ้าย ↔ ขวา`], ['fy', T`หน้า: ตำแหน่ง ล่าง ↕ บน`], ['fsize', T`หน้า: ใกล้ ↔ ไกลกล้อง`],
];
export const isFaceDrive = (s) => typeof s === 'string' && s.length > 1 && s[0] === 'f' && FACE_DRIVES().some((d) => d[0] === s);
