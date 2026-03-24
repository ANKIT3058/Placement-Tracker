import 'dotenv/config'; // Add this at the very top
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const { Pool } = pg;

// Initialize the pg Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create the adapter
const adapter = new PrismaPg(pool);

console.log("Database URL loaded:", !!process.env.DATABASE_URL);

// Instantiate the Client with the adapter
export const prisma = new PrismaClient({ adapter });