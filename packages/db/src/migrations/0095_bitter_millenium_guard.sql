CREATE TABLE "tethr_goal_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'count' NOT NULL,
	"direction" text DEFAULT 'up' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"method" text DEFAULT '' NOT NULL,
	"baseline" double precision,
	"baseline_at" timestamp with time zone,
	"target" double precision,
	"target_date" timestamp with time zone,
	"current" double precision,
	"current_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tethr_goal_metrics" ADD CONSTRAINT "tethr_goal_metrics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_goal_metrics" ADD CONSTRAINT "tethr_goal_metrics_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tethr_goal_metrics_company_goal_idx" ON "tethr_goal_metrics" USING btree ("company_id","goal_id");