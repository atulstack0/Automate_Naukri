import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.openqa.selenium.By;
import org.openqa.selenium.Keys;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;
import org.testng.annotations.Test;

import io.github.bonigarcia.wdm.WebDriverManager;

public class NaukariQA 
{
	@Test
	public static void QA() throws InterruptedException
	//public static void main(String[] args) throws InterruptedException 
	{
		WebDriverManager.chromedriver().setup();
		WebDriver driver = new ChromeDriver();
		System.out.println("\t Chrome Browser OPEN");
		driver.manage().timeouts().implicitlyWait(35, TimeUnit.SECONDS);
		WebDriverWait wait= new WebDriverWait(driver,21);
		driver.manage().window().maximize();
		System.out.println("\t Window Maximized");
		driver.get("https://www.naukri.com/");
		System.out.println("\t Website Open: "+driver.getCurrentUrl());
		wait.until(ExpectedConditions.visibilityOfElementLocated(By.className("Login"))).click();
		System.out.println("\t Clicked On Login Button");
		wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("input[placeholder*='Username']"))).sendKeys("Enter Your Email", Keys.TAB); // Enter E-mail Id.
		driver.switchTo().activeElement().sendKeys("PASSWORD",Keys.ENTER); // Enter Password
		System.out.println("\t Username And Password Enterd ");
		wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("qsb-keyskill-sugg"))).sendKeys("Manual Tester", Keys.ENTER);
		System.out.println("\t Search Field Enter And Press Search Button");
		wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("filter-freshnessFor"))).click();
		System.out.println("\t Clicked On Freshness Button");
		wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("a[data-id='filter-freshness_1']"))).click();
		System.out.println("\t Clicked On 1 Day In Freshness Table");
		wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("span[title='Company Jobs']"))).click();
		System.out.println("\t Clicked on Company Jobs");
		System.out.println(driver.getTitle());
//	}
//}
//class Apply extends NaukariQA 
//{
//	@Test
//	public static void Applying() 
//	{
//			WebDriver driver = new ChromeDriver();
//			String[] USkills= {"Java","Selenium","Black Box Testing","TestNG"};
			List<WebElement> JobTitle = driver.findElements(By.cssSelector("a[class='title fw500 ellipsis']")); 
			for(int i=0,j=0;i<=JobTitle.size();i++,j++)
			{
				while (i==JobTitle.size())
		      	{
		    	  driver.findElement(By.cssSelector("a[class='fright fs14 btn-secondary br2']")).click();
		    	  System.out.println("Click on Next Button");
		    	//  Thread.sleep(3000);
		    	  i=0;
		      	}
//				WebDriverWait wait= new WebDriverWait(driver,20);
//		    	wait.until(ExpectedConditions.visibilityOfElementLocated(By.xpath("//a[@class='title fw500 ellipsis']")));
//				List<WebElement> Skills = driver.findElements(By.xpath("//a[@class='chip clickable']&[@class='chip clickable']"));
				try
				{
				System.out.println(j+1+". Job Title: "+JobTitle.get(i).getText());
				JobTitle.get(i).click();
				}
				catch(org.openqa.selenium.StaleElementReferenceException ex)
				{
					List<WebElement> JobTitle2 = driver.findElements(By.xpath("//a[@class='title fw500 ellipsis']"));
					System.out.println(j+1+". Job Title: "+JobTitle2.get(i).getText());
					JobTitle2.get(i).click();
				}
				ArrayList<String> newTb = new ArrayList<String>(driver.getWindowHandles());
				driver.switchTo().window(newTb.get(1));
		      
		       try
		       	{
		    	  	if (wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("button[class='waves-effect waves-ripple btn apply-button']"))).isDisplayed())
		    	  	{
		    	  			WebElement ApplyButton = wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("button[class='waves-effect waves-ripple btn apply-button']")));
		    	  			ApplyButton.click();
		    	  			Thread.sleep(2000);
		    	  			driver.getWindowHandles();
		    	  			wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("body"))).sendKeys(Keys.TAB,Keys.TAB);
//		    	  			
		    	  			if(wait.until(ExpectedConditions.visibilityOfElementLocated(By.className("ltGlobalTtl"))).isDisplayed())
		    	  			{
		    	  				if(wait.until(ExpectedConditions.visibilityOfElementLocated(By.className("skipLink"))).isDisplayed())
		    	  				{
		    	  				wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("body"))).sendKeys(Keys.TAB,Keys.TAB);
	  							System.out.println("default contain using tab");
		    	  				driver.findElement(By.className("skipLink")).click();
		    	  				}
		    	  			}
		    	  			else if(wait.until(ExpectedConditions.visibilityOfElementLocated(By.className("ltGlobalTtl"))).isDisplayed())
		    	  					{
		    	  						wait.until(ExpectedConditions.visibilityOfElementLocated(By.xpath("//body"))).sendKeys(Keys.TAB,Keys.TAB);
		    	  						System.out.println("default contain using tab");
	  									System.out.println(" FILL THIS PAGE");
		    	  						if(wait.until(ExpectedConditions.visibilityOfElementLocated(By.xpath("//*[contains(text(),'Expected')][contains(text(),'Your')])"))).isDisplayed())
		    	  						{
		    	  							System.out.println("Under expctexd ctc label tag");
		    	  							wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("body"))).sendKeys(Keys.TAB,Keys.TAB);
		    	  							System.out.println("default contain using tab");
		    	  							wait.until(ExpectedConditions.visibilityOfElementLocated(By.xpath("//*[contains(text(),'Expected')][contains(text(),'Your')])"))).getText();
		    	  							wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("input[type='text']"))).sendKeys("2.5");
		    	  						}
		    	  					}
		    	  			else {
		    	  				System.out.println("out off popup");
		    	  				 }
		    	  	}
		    	  	else if(wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("loginApply"))).isDisplayed())
		    	  	{
		    	  		wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("loginApply"))).click();
		    	  	}
		    	  	else if(wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("walkInButton"))).isDisplayed())
		    	  	{
		    	  		System.out.println(wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("walkInButton"))).getText()+"WalkIn Interview");
		    	  	}
		    	  	else if(wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("button[class='waves-effect waves-ripple btn walkin-button']"))).isDisplayed())
		    	  	{
		    	  		System.out.println(wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("button[class='waves-effect waves-ripple btn walkin-button']"))).getText()+"WalkIn Interview");
		    	  	}
		       	}
		       catch(Throwable e)
		       	{
		    	  // driver.findElement(By.id("loginApply")).click();
		       	}
		       if(driver.getTitle().equalsIgnoreCase("Apply confirmation"))
				{
		    	   try
		    	   {
		    		   if (wait.until(ExpectedConditions.visibilityOfElementLocated(By.className("apply-message"))).isDisplayed())
		    		   {
		    			   String Massage = wait.until(ExpectedConditions.visibilityOfElementLocated(By.className("apply-message"))).getText();
		    			   System.out.println(Massage);
		    		   }
		    		   else
		    		   {
		    			   System.out.println("Page Title: "+driver.getTitle()+ "\n\t Applied Sucessfully");
		    		   }
		    	   }
		    	   catch(Throwable a)
		    	   {
						if(wait.until(ExpectedConditions.visibilityOfElementLocated(By.className("already-applied"))).isDisplayed())
						{
							System.out.println("\n\t Already Applied");
						}
		    	   }
				}
		    	 else
					{
						System.out.println("\n\t NOT APPLIED");
					}
		       driver.close();
		       driver.switchTo().window(newTb.get(0));
			}
	}
}
	

	
//*********************************************************************************************************************************************************************************************************************************
		      
		
	


	




