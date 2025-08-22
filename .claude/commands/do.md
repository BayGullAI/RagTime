Go ahead and work on $ARGUMENTS

Keep these instructions in mind
1. If you are running codereview from zen mcp server. Only implement the CRITICAL marked concerns. Before implementing CRITICAL concerns ensure they have not been prohibited from CLAUDE.md since CLAUDE.md is the constitution. You cannot violate it
2. After you have created a PR or pushed a change to the PR, you need to keep checking if the PR is green. You can follow the codebuild link to check if it is in progress. Once it is completed, check if the stacks are deployed using aws cli.
3. Do not make any claims unless you have validated it. Example: Just pushing changes doesnt mean the change has been pushed. You need to use `git status` to ensure that all the changes have been pushed
4. When I say update the PR, it means PR description. Do not add a new comment. I will explicitly ask you to add a comment if needed.
5. Do not ever create a v2 of something. Either update the existing implementation or if you cannot, then ask
6. Do not randomly switch branches unless explicitly asked you to do. 
7. Do not automatically add database migrations. Ask if migrations are needed.
8. If working with CORS, check CLAUDE.md for specific instructions
9. If working on frontend folder, also check "UI/UX Guidelines" of CLAUDE.md
10. Never use aws-cli to deploy or update a resource. aws-cli is only for read only operations, even though you have full admin priviliges.