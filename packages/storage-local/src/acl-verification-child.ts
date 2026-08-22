import { LocalSavePointRepository } from "./index.js";

const projectRoot = process.argv[2];
if (projectRoot === undefined) throw new Error("project root is required");

const repository = new LocalSavePointRepository({ projectRoot });
repository.close();
