# Project description

- This project is created for Final sem submission 
- The course is MTech for Data-science and Artificial Intelligence
- The project is about analyzing nutrition details and giving personalized recommendations by using ai in various steps of the process
- The backend uses python with FAST API for REST, pydantic for analyzing, several API to get standard nutrition details, several transforms for image recognition, whisper for voice transcribing
- The frontend is done in angular.

## prompt - 1

### Disclaimer:
- The project already has a good base, right now on image recognition we detect the food against a standard base, this does not tell the contents of the food. We can't predict the contents of the food via image, hence when using this api we need to notify user as a disclaimer that this food is verified against a standard value and that this gives the estimated value and not the exact value. We need to tell it something like this and not exactly like this because if we told exactly the credibilty of the project that we are taking care of your nutrition goals

### Activity list:
- Currently the project has no way to add the users activities, whether he did any activity like gym or physical activity. We need to provide a way for him to add all the details. Since we are using AI in the project we should let the user enter details however he wants, this reduces the pain point of checking tick boxes or adding multiple details in a fixed set of options. Once user enters the details we can extract the information out of it, make it into something closer to a standard json and then use any free api's and get calories burn and other details for that info. We can also suggest what to add in the text box placeholder,
- Note that this is a daily adding feature, this might require some updates on logging feature that already exists. Currently in logging we only show meal details. Hence when clicked on that day we can show all the meals he had on that day and all the activities he did, along with its details in a seperate page. 
- Let the meal modal be as is for now

### Monthly graph:
- In the recommendation page, we are only showing the insights for that month, and the aggregated values by week and month. 
- Expectation is to see following graphs: 
    - calories burn vs date
    - protien intake vs date
    - fibre intake vs date
    - carb intake vs date
    - vitamin intake vs date
- Note that date here is of three types:
    - all the days in the month
    - the weeks of the month
    - all the momths in the year
- User should be given a select option to choose between the graphs and tab view for the date switch
- Use any beautiful looking graphs library to expedite the graph creation
- This should be in recommendation page under a good title that says something like "See how you are doing"