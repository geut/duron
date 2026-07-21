CREATE TABLE "duron"."clients" (
	"client_id" text PRIMARY KEY,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
