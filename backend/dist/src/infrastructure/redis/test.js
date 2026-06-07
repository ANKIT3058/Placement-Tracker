import "dotenv/config";
import { redis } from "./redis.js";
await redis.set("test", "hello");
const value = await redis.get("test");
console.log(value);
process.exit(0);
//# sourceMappingURL=test.js.map