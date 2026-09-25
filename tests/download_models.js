// Downloads the open IFC models used by tests/cases/open_models.json into tests/models/.
//
// run:  node tests/download_models.js
//
// Files that are already there are skipped. Each file is checked against the fingerprint
// (SHA-256) of the exact version the expected answers were computed from: if the owner of a
// repository changes a file later, you get a warning instead of silently wrong test results.
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BSI = "https://raw.githubusercontent.com/buildingSMART/Sample-Test-Files/main";
const MODELS = [
  {
    file: "Duplex.ifc", // IFC2X3, Revit export: 2-family house
    url: "https://raw.githubusercontent.com/MadsHolten/BOT-Duplex-house/master/Model%20files/IFC/Duplex.ifc",
    sha256: "b347a2c8aa8fff6db896a4417a9c50c22ac0ccd7c5cfc22b99b8d29336c606ed"
  },
  {
    file: "Building-Architecture.ifc", // IFC4, buildingSMART "simple scene"
    url: `${BSI}/IFC%204.0.2.1%20(IFC%204%20ADD2%20TC1)/Simple-Scene/Building-Architecture.ifc`,
    sha256: "8790a1e193e82b8e7e7f337ec2633cd40f2120590317a1443503a25b079e2e80"
  },
  {
    file: "Building-Structural.ifc",
    url: `${BSI}/IFC%204.0.2.1%20(IFC%204%20ADD2%20TC1)/Simple-Scene/Building-Structural.ifc`,
    sha256: "903b5a005901397aa2b235daf6a60f46c099eae286cb01c815abf0a341707432"
  },
  {
    file: "Building-Hvac.ifc",
    url: `${BSI}/IFC%204.0.2.1%20(IFC%204%20ADD2%20TC1)/Simple-Scene/Building-Hvac.ifc`,
    sha256: "2c17ecad2b0fbd3335420ee42ba48963b5a395294e86bcdcfc786ee559f9a344"
  },
  {
    file: "wall-with-opening-and-window.ifc", // IFC4, one wall with a window
    url: `${BSI}/IFC%204.0.2.1%20(IFC%204%20ADD2%20TC1)/ISO%20Spec%20-%20ReferenceView_V1.2/wall-with-opening-and-window.ifc`,
    sha256: "73b0e45d931d5dc13bfee5fdc7bd80f796526445458b2de74c4168d209097832"
  },
  {
    file: "Infra-Bridge.ifc", // IFC4X3, bridges
    url: `${BSI}/IFC%204.3.2.0%20(IFC%204.3%20ADD2)/Simple-Scene/Infra-Bridge.ifc`,
    sha256: "97e84cb93e07bfbedbc1bdc57aef161f4998e09accd77175dd0561af2ab4ffab"
  },
  {
    file: "Infra-Road.ifc", // IFC4X3, roads
    url: `${BSI}/IFC%204.3.2.0%20(IFC%204.3%20ADD2)/Simple-Scene/Infra-Road.ifc`,
    sha256: "a3cb29433d7176bd31ff7535a596b5d7cd4eb7f2fb0eb6eee451612063c1f167"
  },
  {
    file: "Schependomlaan.ifc", // IFC2X3, ArchiCAD/Synchro export, 65 MB, 3,505 elements
    url: "https://raw.githubusercontent.com/ibpsa/project1-wp-2-2-bim/master/IFC_Files/MISC/Schependomlaan.ifc",
    sha256: "57fafa59f03b18c05be211a456e346bdd0445d5c35d66522e598d339e81dfcf4"
  }
];

const modelsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "models");
mkdirSync(modelsDir, { recursive: true });

const fingerprint = (buffer) => createHash("sha256").update(buffer).digest("hex");

for (const m of MODELS) {
  const target = path.join(modelsDir, m.file);
  if (!existsSync(target)) {
    process.stdout.write(`downloading ${m.file} ... `);
    const response = await fetch(m.url);
    if (!response.ok) {
      console.log(`FAILED (HTTP ${response.status})\n  ${m.url}`);
      continue;
    }
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    console.log("done");
  }
  const same = fingerprint(readFileSync(target)) === m.sha256;
  console.log(same
    ? `  ok       ${m.file}`
    : `  CHANGED  ${m.file}: not the version the tests were made from. ` +
      `Run "node tests/check_cases.js" to see which expected answers still hold.`);
}
