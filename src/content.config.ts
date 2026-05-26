import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";

const subscoreSchema = z.record(
  z.string(),
  z.union([
    z.number(),
    z.object({ score: z.number(), count: z.number() }),
  ]),
);

const baremo = defineCollection({
  loader: file("src/data/baremo.json"),
  schema: z.object({
    id: z.string(),
    dni: z.string(),
    nombre: z.string(),
    total: z.number(),
    subscores: subscoreSchema,
  }),
});

export const collections = { baremo };
