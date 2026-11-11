ALTER TABLE "tethr_agent_profiles" DROP CONSTRAINT "tethr_agent_profiles_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_divisions" DROP CONSTRAINT "tethr_divisions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_drive_nodes" DROP CONSTRAINT "tethr_drive_nodes_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_drive_versions" DROP CONSTRAINT "tethr_drive_versions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_memories" DROP CONSTRAINT "tethr_memories_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_notifications" DROP CONSTRAINT "tethr_notifications_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_outputs" DROP CONSTRAINT "tethr_outputs_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_route_runs" DROP CONSTRAINT "tethr_route_runs_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_subagents" DROP CONSTRAINT "tethr_subagents_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "tethr_agent_profiles" ADD CONSTRAINT "tethr_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_divisions" ADD CONSTRAINT "tethr_divisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_drive_nodes" ADD CONSTRAINT "tethr_drive_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_drive_versions" ADD CONSTRAINT "tethr_drive_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_memories" ADD CONSTRAINT "tethr_memories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_notifications" ADD CONSTRAINT "tethr_notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_outputs" ADD CONSTRAINT "tethr_outputs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_route_runs" ADD CONSTRAINT "tethr_route_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_subagents" ADD CONSTRAINT "tethr_subagents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;