CREATE TABLE "tethr_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"origin" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"slack_channel" text,
	"slack_thread_ts" text,
	"route_run_id" uuid,
	"card_run_id" uuid,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tethr_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"position" text DEFAULT 'other' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"user_id" text,
	"slack_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tethr_goal_metrics" ADD COLUMN "adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tethr_ideas" ADD CONSTRAINT "tethr_ideas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_members" ADD CONSTRAINT "tethr_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tethr_ideas_company_created_idx" ON "tethr_ideas" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tethr_members_company_idx" ON "tethr_members" USING btree ("company_id");