import type { Rng } from "./rng.ts";
import { list } from "./text.ts";

const FIRST_NAMES = list(`
  Ada, Priya, Jun, Leo, Rosa, Marcus, Nina, Yuki, Omar, Grace, Ivan, Leila, Kenji, Hannah, Samuel,
  Mei, Noah, Sofia, Ethan, Zara, Liam, Aisha, Felix, Ines, Ravi, Chloe, Mateo, Elena, Jonas,
  Amara, Tariq, Freya, Dmitri, Lucia, Kwame, Hana
`);

const LAST_NAMES = list(`
  Okafor, Raman, Park, Marchetti, Delgado, Lindqvist, Okoro, Tanaka, Haddad, Chen, Petrov, Nasser,
  Mori, Weiss, Achebe, Ribeiro, Novak, Silva, Adeyemi, Fischer, Kowalski, Moreau, Iyer, Berg,
  Castillo, Dubois, Yamamoto, Olsen, Mbeki, Rossi
`);

export const COMPANY_WORDS = list(`
  Pinwheel, Saltmarsh, Corvid, Halyard, Kestrel, Ferrule, Marlow, Tidewater, Fathom, Lantern,
  Quill, Meadowlark, Brightline, Northwind, Cobalt, Juniper, Harbor, Ridgeline, Ember, Willow,
  Sable, Orchard, Beacon, Granite, Tallow, Vireo, Osprey, Cinder, Larkspur, Mica, Heron, Pilot,
  Anvil, Bramble, Cairn, Delta, Fennel, Gable, Ironwood, Kite, Loam, Moss, Nimbus, Oxbow, Pebble,
  Quarry, Rook, Slate, Thistle, Umber, Verdant, Wren, Yarrow, Zephyr, Alder, Basalt, Coral, Dune,
  Estuary, Flint
`);

export const SECTORS = list(`
  B2B SaaS, fintech, logistics software, AI infrastructure, devtools, healthcare, climate,
  consumer, maritime, hardware, edtech, legal tech
`);

export const CITIES = ["San Francisco", "New York", "Austin", "Seattle", "Chicago", "London", "Berlin", "Toronto"];

export function randomPath(r: Rng, files: Record<string, string>, dir: string): string {
  let path = `${dir}/${r.int(100000, 999999).toString(16)}.md`;
  while (path in files) path = `${dir}/${r.int(100000, 999999).toString(16)}.md`;
  return path;
}

export function personName(r: Rng): string {
  return `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const PRIVATE_POINTER = (topic: string): string =>
  `This folder belongs to the partners' scope. The ${topic} lives in the partner workspace, which this scope cannot read. Do not try to reach it; work from the files you have.\n`;

export function nameVariant(r: Rng, name: string): string {
  const [first, last] = name.split(" ") as [string, string];
  return r.pick([name, `${first[0]}. ${last}`, `${last}, ${first}`, name.toUpperCase(), `${first} ${last}`]);
}
