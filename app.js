const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const exphbs = require('express-handlebars');
const cors = require('cors');
const path = require('path');
const { HfInference } = require("@huggingface/inference");
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3001;
const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

app.engine('handlebars', exphbs.engine());
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const inference = new HfInference(process.env.HF_API_KEY);

// Fallback plan generator function
function generateFallbackPlan(subject, level, duration, goals) {
    const durationWeeks = parseInt(duration.match(/\d+/)) || 4;
    const weeksText = durationWeeks > 1 ? 'weeks' : 'week';
    
    return `Study Plan for ${subject} (${level} Level)
Duration: ${duration}
Goals: ${goals}

=== STUDY PLAN OVERVIEW ===

Phase 1: Foundation (Week 1${durationWeeks > 2 ? '-2' : ''})
- Review fundamental concepts and terminology
- Gather study materials and resources
- Establish daily study routine (1-2 hours)
- Complete basic exercises and assessments

Phase 2: Core Learning (Week ${durationWeeks > 2 ? '3-' + Math.ceil(durationWeeks * 0.7) : '2'})
- Deep dive into main topics and concepts
- Practice problem-solving techniques
- Create summary notes and mind maps
- Regular self-assessment and progress tracking

Phase 3: Advanced Application (Week ${Math.ceil(durationWeeks * 0.7) + 1}-${durationWeeks - 1})
- Explore complex topics and real-world applications
- Work on challenging problems and case studies
- Connect concepts across different areas
- Prepare for practical implementation

Phase 4: Review & Mastery (Final Week)
- Comprehensive review of all materials
- Practice tests and mock examinations
- Identify and address knowledge gaps
- Final preparation and confidence building

=== DAILY STUDY STRUCTURE ===

Morning Session (30-45 minutes):
- Review previous day's material
- Preview new concepts for the day

Main Study Session (60-90 minutes):
- Focus on new topic learning
- Complete practice exercises
- Take detailed notes

Evening Review (15-30 minutes):
- Summarize key learnings
- Plan next day's study goals
- Update progress tracker

=== WEEKLY MILESTONES ===

Week 1: Master foundational concepts
Week 2: Complete core topic modules
${durationWeeks > 2 ? 'Week 3: Apply knowledge to practical scenarios\n' : ''}${durationWeeks > 3 ? 'Week 4: Integrate advanced concepts\n' : ''}Final Week: Achieve mastery and meet stated goals

=== STUDY TIPS ===

- Use active learning techniques (summarizing, teaching others)
- Take regular breaks using the Pomodoro technique
- Create a distraction-free study environment
- Join study groups or find accountability partners
- Regularly assess progress and adjust plan as needed

Note: This is a template plan generated when AI services are unavailable. For a more personalized and detailed study plan, please try again later when our AI service is restored.`;
}

// Model status checker endpoint
app.get('/check-models', async (req, res) => {
    const models = [
        "mistralai/Mistral-7B-Instruct-v0.3",
        "microsoft/DialoGPT-medium",
        "google/flan-t5-large",
        "facebook/blenderbot-400M-distill",
        "bigscience/bloom-560m"
    ];

    const modelStatus = {};

    for (const model of models) {
        try {
            const testResponse = await inference.textGeneration({
                model: model,
                inputs: "Hello",
                parameters: { max_new_tokens: 5 }
            });
            modelStatus[model] = "Available";
        } catch (error) {
            modelStatus[model] = `Unavailable: ${error.message}`;
        }
    }

    res.json({
        timestamp: new Date().toISOString(),
        modelStatus: modelStatus
    });
});

// Main study plan generation endpoint
app.post('/generate-plan', async (req, res) => {
    const { subject, level, duration, goals } = req.body;

    // Input validation
    if (!subject || !level || !duration || !goals) {
        return res.status(400).json({ 
            error: 'Missing required fields: subject, level, duration, and goals are all required' 
        });
    }

    const prompt = `Create a comprehensive, personalized study plan with the following specifications:

Subject: ${subject}
Academic Level: ${level}
Study Duration: ${duration}
Learning Goals: ${goals}

Please structure the response with:
1. Study plan overview with phases
2. Weekly breakdown with specific topics
3. Daily study schedule recommendations
4. Key milestones and checkpoints
5. Assessment methods and progress tracking
6. Recommended resources and materials
7. Tips for effective learning

Make the plan detailed, practical, and tailored to the specified level and duration.`;

    // List of models to try in order of preference
    const models = [
        "mistralai/Mistral-7B-Instruct-v0.3",
        "microsoft/DialoGPT-medium",
        "google/flan-t5-large",
        "facebook/blenderbot-400M-distill",
        "bigscience/bloom-560m"
    ];

    let lastError = null;
    let modelUsed = null;

    // Try each model until one works
    for (const model of models) {
        try {
            console.log(`Attempting to use model: ${model}`);
            
            const response = await inference.textGeneration({
                model: model,
                inputs: prompt,
                parameters: { 
                    max_new_tokens: 2000,
                    temperature: 0.7,
                    top_p: 0.95,
                    repetition_penalty: 1.15,
                    do_sample: true
                }
            });
            
            console.log(`Successfully got response from ${model}`);
            
            if (response && response.generated_text) {
                let generatedText = response.generated_text;
                
                // Clean up the response by removing the original prompt if it's included
                if (generatedText.includes(prompt)) {
                    generatedText = generatedText.replace(prompt, '').trim();
                }
                
                // Ensure we have meaningful content
                if (generatedText.length < 100) {
                    console.log(`Response too short from ${model}, trying next model`);
                    continue;
                }
                
                modelUsed = model;
                
                // Save to Firebase
                try {
                    const studyPlanRef = await db.collection('studyPlans').add({
                        subject: subject,
                        level: level,
                        duration: duration,
                        goals: goals,
                        plan: generatedText,
                        modelUsed: model,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isAiGenerated: true
                    });

                    return res.json({ 
                        success: true,
                        plan: generatedText,
                        planId: studyPlanRef.id,
                        modelUsed: model,
                        isAiGenerated: true
                    });
                } catch (dbError) {
                    console.error('Firebase save error:', dbError);
                    // Still return the generated plan even if save fails
                    return res.json({ 
                        success: true,
                        plan: generatedText,
                        modelUsed: model,
                        isAiGenerated: true,
                        warning: 'Plan generated successfully but not saved to database'
                    });
                }
            } else {
                console.log(`No generated text from ${model}`);
                lastError = new Error('No generated text in response');
            }
        } catch (error) {
            console.error(`Error with model ${model}:`, error.message);
            lastError = error;
            // Continue to next model
        }
    }

    // If all AI models fail, use fallback plan
    console.log('All AI models failed, using fallback plan');
    
    const fallbackPlan = generateFallbackPlan(subject, level, duration, goals);
    
    try {
        // Save fallback plan to Firebase
        const studyPlanRef = await db.collection('studyPlans').add({
            subject: subject,
            level: level,
            duration: duration,
            goals: goals,
            plan: fallbackPlan,
            modelUsed: 'fallback',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            isAiGenerated: false
        });

        res.json({ 
            success: true,
            plan: fallbackPlan,
            planId: studyPlanRef.id,
            modelUsed: 'fallback',
            isAiGenerated: false,
            message: 'AI services are currently unavailable. A template study plan has been generated for you.'
        });
    } catch (dbError) {
        console.error('Firebase save error for fallback plan:', dbError);
        res.json({ 
            success: true,
            plan: fallbackPlan,
            modelUsed: 'fallback',
            isAiGenerated: false,
            message: 'AI services are currently unavailable. A template study plan has been generated for you.',
            warning: 'Plan not saved to database due to connection issues'
        });
    }
});

// Get saved study plans endpoint
app.get('/study-plans', async (req, res) => {
    try {
        const snapshot = await db.collection('studyPlans')
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();
        
        const plans = [];
        snapshot.forEach(doc => {
            plans.push({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate()
            });
        });
        
        res.json({ success: true, plans: plans });
    } catch (error) {
        console.error('Error fetching study plans:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch study plans',
            details: error.message 
        });
    }
});

// Get specific study plan endpoint
app.get('/study-plan/:id', async (req, res) => {
    try {
        const doc = await db.collection('studyPlans').doc(req.params.id).get();
        
        if (!doc.exists) {
            return res.status(404).json({ 
                success: false, 
                error: 'Study plan not found' 
            });
        }
        
        const planData = {
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate()
        };
        
        res.json({ success: true, plan: planData });
    } catch (error) {
        console.error('Error fetching study plan:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch study plan',
            details: error.message 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        server: 'study-plan-generator',
        version: '1.0.0'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        message: 'Something went wrong on our end. Please try again later.'
    });
});

// Handle 404 routes
app.use('*', (req, res) => {
    res.status(404).json({ 
        success: false,
        error: 'Route not found',
        message: `The requested endpoint ${req.originalUrl} does not exist.`
    });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Health check available at: http://localhost:${port}/health`);
    console.log(`Model status check available at: http://localhost:${port}/check-models`);
});