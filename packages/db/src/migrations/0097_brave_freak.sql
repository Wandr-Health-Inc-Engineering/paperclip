CREATE TABLE "tethr_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pick" text NOT NULL,
	"runner_up" text,
	"confidence" double precision NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"mode" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"corrected_to" text,
	"subject_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tethr_inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"rel_path" text NOT NULL,
	"size" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"suggestion" jsonb,
	"note" text,
	"filed_to" text,
	"filed_by" text,
	"filed_from" text,
	"filed_at" timestamp with time zone,
	"card_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"area" text NOT NULL,
	"lesson" text NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"how_to_apply" text DEFAULT '' NOT NULL,
	"apply_as" text DEFAULT 'principle' NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" text DEFAULT 'team' NOT NULL,
	"scores" jsonb,
	"status" text DEFAULT 'candidate' NOT NULL,
	"applied" jsonb,
	"goal_id" uuid,
	"metric_id" uuid,
	"review_at" timestamp with time zone,
	"outcome" text,
	"proposed_by" text NOT NULL,
	"card_run_id" uuid,
	"composite" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tethr_decisions" ADD CONSTRAINT "tethr_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_inbox_items" ADD CONSTRAINT "tethr_inbox_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_lessons" ADD CONSTRAINT "tethr_lessons_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tethr_decisions_company_kind_idx" ON "tethr_decisions" USING btree ("company_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "tethr_decisions_subject_idx" ON "tethr_decisions" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "tethr_inbox_items_company_status_idx" ON "tethr_inbox_items" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "tethr_lessons_company_status_idx" ON "tethr_lessons" USING btree ("company_id","status","created_at");