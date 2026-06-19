# Prompt

- This project contains folders for Backend, Frontend and prompts
- Backend is built using python
- Frontend is built using angular
- Prompt folder contains prompts for backend and frontend.

## current expectation
- Build an angular app in spa mode, routing enabled, scss styles, no ssr
- The app should show a login page with only email field onload 
- The app should check for userid in localStorage on load while showing the login page
- If userid is present in localStorage, then the app 
    - should call api to get user details
    - enable password field
    - prefill email field with email from user details
- If userid is not present in localStorage, then the app should show the login page with only email field
- On email submit, 
    - call api to get user details
- If api returns user exist then enable password field
- If api returns user not exist then show register page with email field
- Register page fields:
    - name
    - email
    - password
    - Tell us about yourself (textarea)
    - confirm button
- On register confirm backend will send userid, token and userdetails text back
- Store the userid and token into localstorage
- Show the userdetails text on screen in <ul> as list with heading "We noted these details about you. Do you want to confirm?"
- Below userdetails add another text area with placeholder "Any modifications?"
- Add confirm button at the bottom
- If confirm button is clicked then call api to save user details
- If textarea is not empty then update the confirm button to "Update"
- On update call the api with payload being the textarea details
- On update show the same page again with updated userdetails returned from api
- On confirm button click go to landing page 
- landing page is a protected route so check for token in localstorage on load
- Landing page component name: "WhatYouAteTodayComponent"
- Keep a placeholder on landing page that says "What you ate today?"