CREATE TABLE "tethr_memory_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target" text DEFAULT 'company' NOT NULL,
	"text" text NOT NULL,
	"area" text,
	"saved_by" text NOT NULL,
	"thread_id" text,
	"run_id" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"in_core" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"recall_count" integer DEFAULT 0 NOT NULL,
	"last_recalled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED
);
--> statement-breakpoint
ALTER TABLE "tethr_memory_notes" ADD CONSTRAINT "tethr_memory_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tethr_memory_notes_company_core_idx" ON "tethr_memory_notes" USING btree ("company_id","in_core");--> statement-breakpoint
CREATE INDEX "tethr_memory_notes_search_idx" ON "tethr_memory_notes" USING gin ("search");